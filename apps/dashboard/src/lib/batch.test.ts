import {describe, expect, it} from "vitest";
import type {Address} from "@stampd/shared";
import {mergeRecipients} from "./batch";

const A = "0x7420a39DC8eAaa366169090f2473C0C379a59E35" as Address;
const B = "0x347eCF1ba316bB31fFbc20d4ce370B9a0D841043" as Address;

describe("mergeRecipients", () => {
    it("issues to the pending address alone in the default two-step flow", () => {
        expect(mergeRecipients([], A)).toEqual([A]);
    });

    it("has nobody to badge before anything is scanned", () => {
        expect(mergeRecipients([], null)).toEqual([]);
    });

    it("issues to the batch when the field has been cleared by Add", () => {
        expect(mergeRecipients([A, B], null)).toEqual([A, B]);
    });

    // The failure this guards against is silent: an organizer working a line scans someone,
    // forgets to press Add, issues, and that person never finds out they were skipped.
    it("still badges a pending attendee who was never added to the batch", () => {
        expect(mergeRecipients([A], B)).toEqual([A, B]);
    });

    it("does not list the same attendee twice when they are already in the batch", () => {
        expect(mergeRecipients([A, B], A)).toEqual([A, B]);
    });

    it("treats differently-cased forms of one address as the same attendee", () => {
        expect(mergeRecipients([A], A.toLowerCase() as Address)).toEqual([A]);
    });

    it("does not mutate the batch it was given", () => {
        const queue: Address[] = [A];
        mergeRecipients(queue, B);
        expect(queue).toEqual([A]);
    });
});
