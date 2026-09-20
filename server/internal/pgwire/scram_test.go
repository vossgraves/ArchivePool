package pgwire

import (
	"encoding/base64"
	"testing"
)

// RFC 7677 §3 test vector: user "user", password "pencil", the documented nonces, salt and
// 4096 iterations. Proving client-final and server-final byte-for-byte is the only way to be sure
// SCRAM interops with Neon/Railway without a live connection.
const (
	rfc7677ClientNonce = "rOprNGfwEbeRWgbNEkqO"
	rfc7677ServerNonce = "%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"
	rfc7677Salt        = "W22ZaJ0SNY7soEsUEjb6gQ=="
	rfc7677Iterations  = 4096
	rfc7677ClientFirst = "n,,n=user,r=rOprNGfwEbeRWgbNEkqO"
	rfc7677ServerFirst = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"
	rfc7677ClientFinal = "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
	rfc7677ServerFinal = "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="
	rfc7677Password    = "pencil"
	rfc7677User        = "user"
)

func TestSCRAMClientFinalMatchesRFC7677(t *testing.T) {
	s := newSCRAM(rfc7677User, rfc7677Password)
	s.nonce = rfc7677ClientNonce
	s.clientFirstBare = "n=" + rfc7677User + ",r=" + rfc7677ClientNonce

	final, err := s.clientFinal([]byte(rfc7677ServerFirst))
	if err != nil {
		t.Fatalf("clientFinal: %v", err)
	}
	if string(final) != rfc7677ClientFinal {
		t.Fatalf("client-final mismatch\n got: %s\nwant: %s", final, rfc7677ClientFinal)
	}
}

func TestSCRAMServerSignatureVerifies(t *testing.T) {
	s := newSCRAM(rfc7677User, rfc7677Password)
	s.nonce = rfc7677ClientNonce
	s.clientFirstBare = "n=user,r=" + rfc7677ClientNonce
	if _, err := s.clientFinal([]byte(rfc7677ServerFirst)); err != nil {
		t.Fatalf("clientFinal: %v", err)
	}
	if err := s.verifyServerFinal([]byte(rfc7677ServerFinal)); err != nil {
		t.Fatalf("verifyServerFinal: %v", err)
	}
	// A tampered signature must be rejected.
	if err := s.verifyServerFinal([]byte("v=" + base64.StdEncoding.EncodeToString(make([]byte, 32)))); err == nil {
		t.Fatal("expected tampered server signature to be rejected")
	}
}

func TestSCRAMNonceMustExtendClientNonce(t *testing.T) {
	s := newSCRAM("user", "pencil")
	s.nonce = rfc7677ClientNonce
	s.clientFirstBare = "n=user,r=" + rfc7677ClientNonce
	if _, err := s.clientFinal([]byte("r=othernonce,s=" + rfc7677Salt + ",i=4096")); err == nil {
		t.Fatal("expected a non-extending server nonce to be rejected")
	}
}

func TestSCRAMUsernameEscaping(t *testing.T) {
	cases := map[string]string{
		"user":      "user",
		"a,b":       "a=2Cb",
		"a=b":       "a=3Db",
		"a=3D,b=2C": "a=3D3D=2Cb=3D2C",
	}
	for in, want := range cases {
		if got := scramEscape(in); got != want {
			t.Errorf("scramEscape(%q) = %q, want %q", in, got, want)
		}
	}
}

func toHex(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, v := range b {
		out = append(out, digits[v>>4], digits[v&0x0f])
	}
	return string(out)
}
