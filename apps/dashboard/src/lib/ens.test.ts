import {describe, expect, it} from "vitest";
import {looksLikeEnsName} from "./ens";

describe("looksLikeEnsName", () => {
    it("accepts the names an organizer would actually type", () => {
        expect(looksLikeEnsName("alice.eth")).toBe(true);
        expect(looksLikeEnsName("alice.base.eth")).toBe(true);
        expect(looksLikeEnsName("  alice.eth  ")).toBe(true);
    });

    // ENS is not limited to .eth, and hardcoding a suffix list here would silently refuse names
    // that resolve perfectly well.
    it("does not insist on a known suffix", () => {
        expect(looksLikeEnsName("alice.box")).toBe(true);
        expect(looksLikeEnsName("alice.cb.id")).toBe(true);
    });

    // The point of this check is to avoid firing a network request at every keystroke of an
    // address, so anything hex-shaped must never look like a name.
    it("never treats an address as a name", () => {
        expect(looksLikeEnsName("0x7420a39DC8eAaa366169090f2473C0C379a59E35")).toBe(false);
        expect(looksLikeEnsName("0x7420")).toBe(false);
    });

    it("rejects things that cannot be names", () => {
        expect(looksLikeEnsName("")).toBe(false);
        expect(looksLikeEnsName("alice")).toBe(false);
        expect(looksLikeEnsName("alice .eth")).toBe(false);
        expect(looksLikeEnsName(".eth")).toBe(false);
        expect(looksLikeEnsName("alice.")).toBe(false);
        expect(looksLikeEnsName("alice..eth")).toBe(false);
    });
});
