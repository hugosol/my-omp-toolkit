import { describe, expect, test } from "bun:test";

import {
	DEFAULT_STATE,
	STATE_CUSTOM_TYPE,
	injectionFor,
	markedInit,
	parseState,
	readState,
	statusText,
	toggled,
} from "../../extensions/codebase-tools/state";

const stateEntry = (data: unknown) => ({ type: "custom", customType: STATE_CUSTOM_TYPE, data });

describe("parseState", () => {
	test("non-object data falls back to the default off state", () => {
		expect(parseState(undefined)).toEqual(DEFAULT_STATE);
		expect(parseState(null)).toEqual(DEFAULT_STATE);
		expect(parseState("on")).toEqual(DEFAULT_STATE);
		expect(parseState([true, true])).toEqual(DEFAULT_STATE);
	});

	test("reads booleans and rejects non-boolean fields", () => {
		expect(parseState({ on: true, initInjected: true })).toEqual({ on: true, initInjected: true });
		expect(parseState({ on: "yes", initInjected: 1 })).toEqual(DEFAULT_STATE);
	});
});

describe("readState", () => {
	test("no state entry means off", () => {
		expect(readState([])).toEqual(DEFAULT_STATE);
		expect(readState([{ type: "message" }, { type: "custom", customType: "other", data: { on: true } }])).toEqual(
			DEFAULT_STATE,
		);
	});

	test("the last state entry wins", () => {
		expect(
			readState([stateEntry({ on: true, initInjected: false }), stateEntry({ on: false, initInjected: true })]),
		).toEqual({ on: false, initInjected: true });
	});
});

describe("transitions", () => {
	test("toggle flips on and preserves init", () => {
		expect(toggled({ on: false, initInjected: true })).toEqual({ on: true, initInjected: true });
		expect(toggled({ on: true, initInjected: false })).toEqual({ on: false, initInjected: false });
	});

	test("markedInit turns on and marks init", () => {
		expect(markedInit({ on: false, initInjected: false })).toEqual({ on: true, initInjected: true });
	});

	test("injection decision", () => {
		expect(injectionFor({ on: false, initInjected: false })).toBeNull();
		expect(injectionFor({ on: true, initInjected: false })).toBe("init");
		expect(injectionFor({ on: true, initInjected: true })).toBe("reminder");
	});
});

describe("statusText", () => {
	test("marker only while on", () => {
		expect(statusText(true)).toBe("◈ codeBaseTools");
		expect(statusText(false)).toBeUndefined();
	});
});
