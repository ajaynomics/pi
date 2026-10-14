import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { InputEventResult } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

// A submitted prompt is not yet busy while async input handlers run. A custom message that
// started a run in that window made the submitted prompt fail with "Agent is already processing".
describe("AgentSession prompt preparation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(result?: InputEventResult) {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "human") return;
						entered.resolve();
						await release.promise;
						return result;
					});
				},
			],
		});
		harnesses.push(harness);
		const requests: TranscriptContext[] = [];
		harness.setResponses(
			Array.from({ length: 4 }, () => (context: TranscriptContext) => {
				requests.push(context);
				return fauxAssistantMessage("ok");
			}),
		);
		return { harness, requests, entered: entered.promise, release: () => release.resolve() };
	}

	function userTexts(context: TranscriptContext): string[] {
		return context.messages.flatMap((message) =>
			message.role === "user" && typeof message.content !== "string"
				? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				: [],
		);
	}

	for (const deliverAs of ["followUp", "steer"] as const) {
		it(`queues a ${deliverAs} custom message sent while input handlers run behind the submitted prompt`, async () => {
			const { harness, requests, entered, release } = await setup();
			const human = harness.session.prompt("human");
			await entered;
			const mail = harness.session.sendCustomMessage(
				{ customType: "mail", content: "peer mail", display: true },
				{ triggerTurn: true, deliverAs },
			);
			release();
			await Promise.all([human, mail]);
			await harness.session.waitForIdle();

			expect(userTexts(requests[0])[0]).toBe("human");
			expect(userTexts(requests[requests.length - 1])).toEqual(["human", "peer mail"]);
		});
	}

	it("starts a run for a waiting custom message when the input is handled without a run", async () => {
		const { harness, requests, entered, release } = await setup({ action: "handled" });
		const human = harness.session.prompt("human");
		await entered;
		const mail = harness.session.sendCustomMessage(
			{ customType: "mail", content: "peer mail", display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		release();
		await Promise.all([human, mail]);
		await harness.session.waitForIdle();

		expect(requests).toHaveLength(1);
		expect(userTexts(requests[0])).toEqual(["peer mail"]);
	});
});
