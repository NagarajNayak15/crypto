import CryptoJS from 'crypto-js';

// ==========================================
// 1. GF(256) MATH (Dynamic Generation)
// ==========================================
// We generate tables at runtime to guarantee mathematical accuracy 
// and avoid copy-paste errors in static arrays.

const LOG = new Uint8Array(256);
const EXP = new Uint8Array(512);

// Initialize Tables using Generator 3 (0x03) and Primitive Poly 0x11B (AES standard)
(function initTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        // x = x * 3
        x = (x << 1) ^ (x & 0x80 ? 0x11b : 0); // Multiply by 2
        // We need generator 3, but the loop above calculates powers of 2 (if x started at 1 and just << 1).
        // Wait, standard Rijndael field generation:
        // The loop above generates powers of 2. 
        // Let's use the standard canonical generation loop for 0x11B.
    }
    // Correct loop for AES field (Generator 3)
    // Actually, simple implementation using base 3 is consistent.
    // But to ensure 100% reliability, let's use the widely used 'g=3' logic:
    
    // Reset
    for (let i = 0; i < 256; i++) { LOG[i] = 0; EXP[i] = 0; }
    
    x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x = x ^ (x << 1) ^ (x & 0x80 ? 0x11B : 0); // Generator 3
    }
    
    // Duplicate EXP for easier division/multiplication handling without modulo
    for (let i = 255; i < 512; i++) {
        EXP[i] = EXP[i - 255];
    }
})();

const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
const div = (a, b) => {
    if (b === 0) throw new Error("Div/0");
    if (a === 0) return 0;
    // LOG[a] - LOG[b] + 255 (offset to keep positive)
    return EXP[LOG[a] - LOG[b] + 255];
};
const add = (a, b) => a ^ b;


// ==========================================
// 2. SHAMIR'S SECRET SHARING LOGIC
// ==========================================
function split(secretHex, n, k) {
    const secretBytes = [];
    for (let i = 0; i < secretHex.length; i += 2) {
        secretBytes.push(parseInt(secretHex.substr(i, 2), 16));
    }

    const shares = Array.from({ length: n }, (_, i) => ({ id: i + 1, data: [] }));

    for (let i = 0; i < secretBytes.length; i++) {
        const coeffs = [secretBytes[i]];
        // Random coefficients
        for (let c = 1; c < k; c++) coeffs.push(window.crypto.getRandomValues(new Uint8Array(1))[0]);

        for (let s = 0; s < n; s++) {
            let x = s + 1;
            let y = coeffs[0];
            // Horner's method for polynomial evaluation
            for (let c = 1; c < k; c++) {
                // y = y + coeff * x^c
                // Calculating x^c
                let x_pow = x;
                // Simple power loop (since k is small, usually 2 or 3)
                if (c > 1) {
                     for(let p=1; p<c; p++) x_pow = mul(x_pow, x);
                }
                y = add(y, mul(coeffs[c], x_pow));
            }
            shares[s].data.push(y);
        }
    }
    return shares.map(s => {
        const idHex = s.id.toString(16).padStart(2, '0');
        const dataHex = s.data.map(b => b.toString(16).padStart(2, '0')).join('');
        return idHex + dataHex;
    });
}

function combine(sharesHex) {
    if (!sharesHex || sharesHex.length < 2) return null;
    const shares = sharesHex.map(s => ({
        id: parseInt(s.slice(0, 2), 16),
        data: s.slice(2).match(/.{1,2}/g).map(byte => parseInt(byte, 16))
    }));

    // Verify share lengths
    const len = shares[0].data.length;
    if (shares.some(s => s.data.length !== len)) {
        console.error("Share length mismatch during combine");
        return null;
    }

    const recovered = [];

    for (let i = 0; i < len; i++) {
        let sum = 0;
        // Lagrange Interpolation
        for (let j = 0; j < shares.length; j++) {
            const xj = shares[j].id;
            const yj = shares[j].data[i];
            
            let numerator = 1;
            let denominator = 1;

            for (let m = 0; m < shares.length; m++) {
                if (j === m) continue;
                const xm = shares[m].id;
                
                // Basis polynomial: (x - xm) / (xj - xm)
                // We want value at x=0, so (0 - xm) / (xj - xm)
                // In GF(2^8), subtraction is XOR, so 0 - xm = xm
                numerator = mul(numerator, xm);
                denominator = mul(denominator, add(xj, xm));
            }
            
            const term = mul(yj, div(numerator, denominator));
            sum = add(sum, term);
        }
        recovered.push(sum);
    }
    return recovered.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==========================================
// 3. SSDD PROTOCOL
// ==========================================
export const ssddEncrypt = (message, ttlSeconds) => {
    // 1. Generate Key & IV
    const key = CryptoJS.lib.WordArray.random(32);
    const iv = CryptoJS.lib.WordArray.random(16);
    
    // 2. Strict Hex String Conversion
    const keyHex = key.toString(CryptoJS.enc.Hex);
    const ivHex = iv.toString(CryptoJS.enc.Hex);
    
    console.log(`[ENCRYPT] Key: ${keyHex.substr(0,10)}... IV: ${ivHex.substr(0,10)}...`);

    // 3. Encrypt
    const encrypted = CryptoJS.AES.encrypt(message, key, { iv: iv });
    
    // 4. Create Master Secret (Key + IV)
    const masterSecretHex = keyHex + ivHex;
    const secretHash = CryptoJS.MD5(masterSecretHex).toString();
    
    // 5. Split (Threshold 2 of 3)
    const shares = split(masterSecretHex, 3, 2);

    return {
        incompleteCiphertext: encrypted.ciphertext.toString(CryptoJS.enc.Base64),
        shares: shares,
        secretHash: secretHash // Debug helper
    };
};

export const ssddDecrypt = (incompleteCiphertext, shares) => {
    try {
        if (!shares || shares.length < 2) return null;

        console.log(`[DECRYPT] Reconstructing from ${shares.length} shares...`);

        // 1. Reconstruct Master Secret
        const masterSecretHex = combine(shares);
        if(!masterSecretHex) {
            console.error("Reconstruction returned null");
            return null;
        }

        // 2. Extract Key (64 chars) and IV (32 chars)
        if (masterSecretHex.length !== 96) {
            console.error(`Invalid Secret Length: ${masterSecretHex.length} (Expected 96)`);
            return null;
        }

        const keyHex = masterSecretHex.slice(0, 64);
        const ivHex = masterSecretHex.slice(64, 96);
        
        console.log(`[DECRYPT] Key: ${keyHex.substr(0,10)}... IV: ${ivHex.substr(0,10)}...`);

        // 3. Decrypt
        const key = CryptoJS.enc.Hex.parse(keyHex);
        const iv = CryptoJS.enc.Hex.parse(ivHex);
        const cipherParams = CryptoJS.lib.CipherParams.create({
            ciphertext: CryptoJS.enc.Base64.parse(incompleteCiphertext)
        });

        const decrypted = CryptoJS.AES.decrypt(cipherParams, key, { iv: iv });
        const plaintext = decrypted.toString(CryptoJS.enc.Utf8);
        
        if (!plaintext) {
            console.error("Decryption produced garbage (Padding Error?)");
            return null;
        }
        
        return plaintext;
    } catch (e) {
        console.error("Decryption Exception:", e);
        return null;
    }
};