import {describe, expect, it} from "vitest";
import {parseWalletAddress, shortAddress} from "./qr";

// The live Stampd1155 deployment, used here only because it is a real checksummed address.
const ADDRESS = "0x7420a39DC8eAaa366169090f2473C0C379a59E35";

describe("parseWalletAddress", () => {
    it("accepts a bare address and returns it checksummed", () => {
        expect(parseWalletAddress(ADDRESS)).toBe(ADDRESS);
        expect(parseWalletAddress(ADDRESS.toLowerCase())).toBe(ADDRESS);
    });

    it("tolerates surrounding whitespace", () => {
        expect(parseWalletAddress(`  ${ADDRESS}  `)).toBe(ADDRESS);
    });

    it("accepts the EIP-831 and EIP-681 forms wallets actually emit", () => {
        expect(parseWalletAddress(`ethereum:${ADDRESS}`)).toBe(ADDRESS);
        expect(parseWalletAddress(`ethereum:${ADDRESS}@84532`)).toBe(ADDRESS);
        expect(parseWalletAddress(`ethereum:${ADDRESS}@84532/transfer?value=1`)).toBe(ADDRESS);
        expect(parseWalletAddress(`ethereum:pay-${ADDRESS}@84532`)).toBe(ADDRESS);
        expect(parseWalletAddress(`ETHEREUM:${ADDRESS}`)).toBe(ADDRESS);
    });

    it("ignores the chain id, since it describes the attendee's wallet and not the badge", () => {
        expect(parseWalletAddress(`ethereum:${ADDRESS}@1`)).toBe(ADDRESS);
    });

    it("rejects anything that is not an address", () => {
        expect(parseWalletAddress("https://example.com/hello")).toBeNull();
        expect(parseWalletAddress("")).toBeNull();
        expect(parseWalletAddress("0x1234")).toBeNull();
        expect(parseWalletAddress(ADDRESS.slice(0, -1))).toBeNull();
    });

    // Regression: `getAddress` computes a checksum rather than validating one, so an earlier
    // version silently "corrected" a corrupted mixed-case address into a valid-looking recipient.
    // Badges are soulbound, so minting to a misread address is permanent.
    it("rejects a mixed-case address whose checksum does not verify", () => {
        const corrupted = `0x7420A39DC8eAaa366169090f2473C0C379a59E35`;
        expect(corrupted).not.toBe(ADDRESS);
        expect(parseWalletAddress(corrupted)).toBeNull();
    });
});

describe("shortAddress", () => {
    it("keeps both ends, which is what someone compares against a phone screen", () => {
        expect(shortAddress(ADDRESS)).toBe("0x7420…9E35");
    });
});
