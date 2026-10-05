// SPDX-License-Identifier: GPL-3.0-or-later
package kdf

import (
	"encoding/hex"
	"testing"
)

// RFC 7914 §12 test vectors. The pool's password format re-derives scrypt with the parameters
// stored in the row, so a hash written by Node's crypto.scrypt must verify here byte for byte.
func TestScryptRFC7914Vectors(t *testing.T) {
	cases := []struct {
		name     string
		password string
		salt     string
		n, r, p  int
		keyLen   int
		want     string
	}{
		{"empty", "", "", 16, 1, 1, 64,
			"77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906"},
		{"password/NaCl", "password", "NaCl", 1024, 8, 16, 64,
			"fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"},
		{"pleaseletmein", "pleaseletmein", "SodiumChloride", 16384, 8, 1, 64,
			"7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Scrypt([]byte(tc.password), []byte(tc.salt), tc.n, tc.r, tc.p, tc.keyLen)
			if hex.EncodeToString(got) != tc.want {
				t.Fatalf("scrypt mismatch\n got: %s\nwant: %s", hex.EncodeToString(got), tc.want)
			}
		})
	}
}

func TestPBKDF2SHA256KnownVectors(t *testing.T) {
	cases := []struct {
		password string
		salt     string
		iter     int
		keyLen   int
		want     string
	}{
		{"password", "salt", 1, 32, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"},
		{"password", "salt", 2, 32, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"},
		{"password", "salt", 4096, 32, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"},
		// The 16777216-iteration vector is the large-c known answer; verified against
		// Python's hashlib.pbkdf2_hmac so the expected value is not taken on trust.
		{"password", "salt", 16777216, 32, "cf81c66fe8cfc04d1f31ecb65dab4089f7f179e89b3b0bcb17ad10e3ac6eba46"},
	}
	for _, tc := range cases {
		if testing.Short() && tc.iter > 4096 {
			continue
		}
		got := PBKDF2SHA256([]byte(tc.password), []byte(tc.salt), tc.iter, tc.keyLen)
		if hex.EncodeToString(got) != tc.want {
			t.Fatalf("pbkdf2(iter=%d) mismatch\n got: %s\nwant: %s", tc.iter, hex.EncodeToString(got), tc.want)
		}
	}
}
