import {describe, expect, it} from "vitest";
import {resolveTab} from "./tabs";

describe("resolveTab", () => {
    it("opens on badging when this wallet can badge", () => {
        expect(resolveTab(null, true)).toBe("scan");
    });

    it("opens on the create form when it cannot", () => {
        expect(resolveTab(null, false)).toBe("create");
    });

    it("keeps whatever the organizer picked", () => {
        expect(resolveTab("all", true)).toBe("all");
        expect(resolveTab("create", true)).toBe("create");
        expect(resolveTab("scan", true)).toBe("scan");
    });

    // The regression this file exists for: All events lists the whole contract and must be
    // reachable by a wallet that has never created anything. Previously no tab bar rendered at
    // all in that case.
    it("lets a wallet with no events reach All events", () => {
        expect(resolveTab("all", false)).toBe("all");
    });

    // Switching wallets mid-session must not leave a tab selected whose screen is empty.
    it("falls back when the selected tab stops being available", () => {
        expect(resolveTab("scan", false)).toBe("create");
    });
});
