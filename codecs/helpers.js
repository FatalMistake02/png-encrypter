/**
 * @param {string} bits - binary string ("0"/"1")
 * @param {string[]} alphabet - unique Unicode characters
 * @returns {string}
 */
export function encodeBinaryString(bits, alphabet) {
    if (bits == "") return "";
    if (!/^[01]*$/.test(bits)) {
        throw new Error("Input must be a binary string");
    }

    const base = BigInt(alphabet.length);

    // Prefix sentinel bit
    let value = 1n;
    for (const b of bits) {
        value = (value << 1n) | BigInt(b);
    }

    // Base convert
    let out = "";
    if (value === 0n) {
        return alphabet[0];
    }

    while (value > 0n) {
        const r = value % base;
        out = alphabet[Number(r)] + out;
        value /= base;
    }

    return out;
}

/**
 * @param {string} str
 * @param {string[]} alphabet
 * @returns {string} binary string
 */
export function decodeBinaryString(str, alphabet) {
  if (str == "") return "";
    const base = BigInt(alphabet.length);
    const index = new Map(alphabet.map((c, i) => [c, BigInt(i)]));

    // Decode Unicode to BigInt
    let value = 0n;
    for (const ch of str) {
        const v = index.get(ch);
        if (v === undefined) {
            throw new Error("Invalid character");
        }
        value = value * base + v;
    }

    // Convert to bits
    let bits = value.toString(2);

    // Remove sentinel "1"
    if (bits[0] !== "1") {
        throw new Error("Invalid encoding");
    }

    return bits.slice(1);
}


export function numToBits(num, numBits = 8) {
    let ret = "";
    for (let bit = numBits - 1; bit >= 0; bit--) {
        ret += (num & (0b1 << bit)) ? "1" : "0";
    }
    return ret;
}

export function bitsToNum(bits) {
    let ret = 0;
    for (const bit of bits) {
        ret = (ret << 1) | (bit === "1" ? 1 : 0);
    }
    return ret;
}

export async function sha256ToOffset(str, mod) {
    const data = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const view = new DataView(hash);
    const high = BigInt(view.getUint32(0));
    const low  = BigInt(view.getUint32(4));
    return Number(((high<<32n)|low) % BigInt(mod));
}
