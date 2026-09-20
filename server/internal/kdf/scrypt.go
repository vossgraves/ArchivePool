package kdf

import (
	"encoding/binary"
	"math/bits"
)

// Scrypt is scrypt (RFC 7914): PBKDF2 → ROMix(salsa20/8) → PBKDF2.
//
// It exists because the TS hashes passwords with Node's crypto.scrypt(N=16384, r=8, p=1, keylen=64)
// and the stored format `N:r:p:salt:hash` must keep verifying. Verification re-derives with the
// parameters stored in the row, so a hash written by the TS must match byte for byte.
func Scrypt(password, salt []byte, n, r, p, keyLen int) []byte {
	if n <= 1 || r <= 0 || p <= 0 {
		return nil
	}
	b := PBKDF2SHA256(password, salt, 1, p*128*r)
	for i := 0; i < p; i++ {
		smix(b[i*128*r:(i+1)*128*r], r, n)
	}
	return PBKDF2SHA256(password, b, 1, keyLen)
}

// smix is ROMix (RFC 7914 §3): the memory-hard mixing loop.
func smix(block []byte, r, n int) {
	words := r * 32 // r * 128 bytes / 4-byte words
	x := make([]uint32, words)
	for i := 0; i < words; i++ {
		x[i] = binary.LittleEndian.Uint32(block[i*4:])
	}
	v := make([]uint32, n*words)
	tmp := make([]uint32, words)

	for i := 0; i < n; i++ {
		copy(v[i*words:], x)
		blockMix(x, tmp, r)
	}
	for i := 0; i < n; i++ {
		// Integerify: the little-endian value of the first 8 bytes of the last 64-byte block.
		j := int(x[(2*r-1)*16]) & (n - 1)
		base := j * words
		for k := 0; k < words; k++ {
			x[k] ^= v[base+k]
		}
		blockMix(x, tmp, r)
	}

	for i := 0; i < words; i++ {
		binary.LittleEndian.PutUint32(block[i*4:], x[i])
	}
}

// blockMix is BlockMix_{salsa20/8, r} (RFC 7914 §3): shuffle the 2r 64-byte blocks through the
// salsa20/8 core and reorder even blocks before odd ones.
func blockMix(x, tmp []uint32, r int) {
	var last [16]uint32
	copy(last[:], x[(2*r-1)*16:])

	for i := 0; i < 2*r; i++ {
		// X = X xor B[i]
		for k := 0; k < 16; k++ {
			last[k] ^= x[i*16+k]
		}
		salsa208(&last)
		copy(tmp[i*16:], last[:])
	}
	// Output: Y[0], Y[2], … then Y[1], Y[3], …
	for i := 0; i < r; i++ {
		copy(x[i*16:], tmp[(2*i)*16:(2*i)*16+16])
	}
	for i := 0; i < r; i++ {
		copy(x[(i+r)*16:], tmp[(2*i+1)*16:(2*i+1)*16+16])
	}
}

// salsa208 is the salsa20/8 core (RFC 7914 §3, from the Salsa20 specification).
func salsa208(block *[16]uint32) {
	x := *block
	for i := 0; i < 8; i += 2 {
		// Column round.
		x[4] ^= bits.RotateLeft32(x[0]+x[12], 7)
		x[8] ^= bits.RotateLeft32(x[4]+x[0], 9)
		x[12] ^= bits.RotateLeft32(x[8]+x[4], 13)
		x[0] ^= bits.RotateLeft32(x[12]+x[8], 18)
		x[9] ^= bits.RotateLeft32(x[5]+x[1], 7)
		x[13] ^= bits.RotateLeft32(x[9]+x[5], 9)
		x[1] ^= bits.RotateLeft32(x[13]+x[9], 13)
		x[5] ^= bits.RotateLeft32(x[1]+x[13], 18)
		x[14] ^= bits.RotateLeft32(x[10]+x[6], 7)
		x[2] ^= bits.RotateLeft32(x[14]+x[10], 9)
		x[6] ^= bits.RotateLeft32(x[2]+x[14], 13)
		x[10] ^= bits.RotateLeft32(x[6]+x[2], 18)
		x[3] ^= bits.RotateLeft32(x[15]+x[11], 7)
		x[7] ^= bits.RotateLeft32(x[3]+x[15], 9)
		x[11] ^= bits.RotateLeft32(x[7]+x[3], 13)
		x[15] ^= bits.RotateLeft32(x[11]+x[7], 18)
		// Row round.
		x[1] ^= bits.RotateLeft32(x[0]+x[3], 7)
		x[2] ^= bits.RotateLeft32(x[1]+x[0], 9)
		x[3] ^= bits.RotateLeft32(x[2]+x[1], 13)
		x[0] ^= bits.RotateLeft32(x[3]+x[2], 18)
		x[6] ^= bits.RotateLeft32(x[5]+x[4], 7)
		x[7] ^= bits.RotateLeft32(x[6]+x[5], 9)
		x[4] ^= bits.RotateLeft32(x[7]+x[6], 13)
		x[5] ^= bits.RotateLeft32(x[4]+x[7], 18)
		x[11] ^= bits.RotateLeft32(x[10]+x[9], 7)
		x[8] ^= bits.RotateLeft32(x[11]+x[10], 9)
		x[9] ^= bits.RotateLeft32(x[8]+x[11], 13)
		x[10] ^= bits.RotateLeft32(x[9]+x[8], 18)
		x[12] ^= bits.RotateLeft32(x[15]+x[14], 7)
		x[13] ^= bits.RotateLeft32(x[12]+x[15], 9)
		x[14] ^= bits.RotateLeft32(x[13]+x[12], 13)
		x[15] ^= bits.RotateLeft32(x[14]+x[13], 18)
	}
	for i := range x {
		block[i] += x[i]
	}
}
