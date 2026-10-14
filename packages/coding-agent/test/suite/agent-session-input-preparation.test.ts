import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InputEventResult } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

// A submitted prompt is not yet busy while async input handlers and the auth check run (#10739 marks
// it busy only from _startRun). A custom message that started a run in that window made the submitted
// prompt fail with "Agent is already processing".
describe("AgentSession prompt preparation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function recordRequests(harness: Harness): TranscriptContext[] {
		const requests: TranscriptContext[] = [];
		harness.setResponses(
			Array.from({ length: 4 }, () => (context: TranscriptContext) => {
				requests.push(context);
				return fauxAssistantMessage("ok");
			}),
		);
		return requests;
	}

	async function setup(result?: InputEventResult) {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let sendMessage: ExtensionAPI["sendMessage"] | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					sendMessage = pi.sendMessage;
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
		if (!sendMessage) throw new Error("Extension did not load");
		return {
			harness,
			requests: recordRequests(harness),
			sendMessage,
			entered: entered.promise,
			release: () => release.resolve(),
		};
	}

	function userTexts(context: TranscriptContext): string[] {
		return context.messages.flatMap((message) =>
			message.role === "user" && typeof message.content !== "string"
				? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				: [],
		);
	}

	it("submits a human prompt without extensions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const requests = recordRequests(harness);
		await harness.session.prompt("human");
		expect(requests).toHaveLength(1);
		expect(userTexts(requests[0])).toEqual(["human"]);
	});

	for (const deliverAs of ["followUp", "steer"] as const) {
		for (const api of ["SDK", "extension"] as const) {
			it(`queues a ${deliverAs} custom message from the ${api} API behind input preparation`, async () => {
				const { harness, requests, sendMessage, entered, release } = await setup();
				const human = harness.session.prompt("human");
				await entered;
				const message = { customType: "mail", content: "peer mail", display: true };
				const options = { triggerTurn: true, deliverAs };
				const mail =
					api === "SDK" ? harness.session.sendCustomMessage(message, options) : sendMessage(message, options);
				release();
				await Promise.all([human, mail]);
				await harness.session.waitForIdle();

				expect(userTexts(requests[0])[0]).toBe("human");
				expect(userTexts(requests[requests.length - 1])).toEqual(["human", "peer mail"]);
			});
		}

		it(`queues a ${deliverAs} custom message behind the async auth check`, async () => {
			const harness = await createHarness();
			harnesses.push(harness);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const respond = Promise.withResolvers<void>();
			const requests: TranscriptContext[] = [];
			harness.setResponses(
				Array.from({ length: 4 }, () => async (context: TranscriptContext) => {
					requests.push(context);
					await respond.promise;
					return fauxAssistantMessage("ok");
				}),
			);
			const runtime = harness.session.modelRuntime;
			const checkAuth = runtime.checkAuth.bind(runtime);
			vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(false);
			vi.spyOn(runtime, "checkAuth").mockImplementationOnce(async (provider) => {
				entered.resolve();
				await release.promise;
				return checkAuth(provider);
			});

			const human = harness.session.prompt("human");
			await entered;
			const mail = harness.session.sendCustomMessage(
				{ customType: "mail", content: "peer mail", display: true },
				{ triggerTurn: true, deliverAs },
			);
			const outcomes = Promise.allSettled([human, mail]);
			// Drain runnable microtasks; keep any started faux request open across auth release.
			await setImmediate();
			release.resolve();
			await setImmediate();
			respond.resolve();
			expect((await outcomes).map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
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

	it("does not deadlock an input handler that awaits a triggering custom message", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "human") return;
						await harness.session.sendCustomMessage(
							{ customType: "mail", content: "peer mail", display: true },
							{ triggerTurn: true, deliverAs: "followUp" },
						);
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		const requests: TranscriptContext[] = [];
		harness.setResponses([
			(context: TranscriptContext) => {
				requests.push(context);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("human");
		await harness.session.waitForIdle();

		expect(requests).toHaveLength(1);
		expect(userTexts(requests[0])).toEqual(["peer mail"]);
	});
});
