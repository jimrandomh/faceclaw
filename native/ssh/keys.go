package faceclawssh

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"

	"golang.org/x/crypto/ssh"
)

// platformSigner adapts the platform's keystore-backed Signer to ssh.Signer.
// The platform signs SHA-256(data) with ECDSA P-256 and returns ASN.1 DER;
// SSH wants the signature as two mpints (RFC 5656 §3.1.2).
type platformSigner struct {
	signer Signer
	pub    ssh.PublicKey
}

func newPlatformSigner(signer Signer) (*platformSigner, error) {
	pub, err := sshPublicKey(signer.PublicKey())
	if err != nil {
		return nil, err
	}
	return &platformSigner{signer: signer, pub: pub}, nil
}

func (p *platformSigner) PublicKey() ssh.PublicKey { return p.pub }

func (p *platformSigner) Sign(_ io.Reader, data []byte) (*ssh.Signature, error) {
	der, err := p.signer.Sign(data)
	if err != nil {
		return nil, fmt.Errorf("platform key signing failed: %w", err)
	}
	var sig struct{ R, S *big.Int }
	rest, err := asn1.Unmarshal(der, &sig)
	if err != nil || len(rest) != 0 || sig.R == nil || sig.S == nil || sig.R.Sign() <= 0 || sig.S.Sign() <= 0 {
		return nil, errors.New("platform key returned a malformed signature")
	}
	blob := ssh.Marshal(struct{ R, S *big.Int }{sig.R, sig.S})
	return &ssh.Signature{Format: p.pub.Type(), Blob: blob}, nil
}

// sshPublicKey parses a platform public key (SubjectPublicKeyInfo DER or an
// uncompressed P-256 point) into an ecdsa-sha2-nistp256 SSH key.
func sshPublicKey(encoded []byte) (ssh.PublicKey, error) {
	var pub *ecdsa.PublicKey
	if len(encoded) == 65 && encoded[0] == 4 {
		parsed, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), encoded)
		if err != nil {
			return nil, fmt.Errorf("bad P-256 point: %v", err)
		}
		pub = parsed
	} else {
		parsed, err := x509.ParsePKIXPublicKey(encoded)
		if err != nil {
			return nil, fmt.Errorf("bad public key: %v", err)
		}
		ecdsaKey, ok := parsed.(*ecdsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("unsupported public key type %T", parsed)
		}
		pub = ecdsaKey
	}
	if pub.Curve != elliptic.P256() {
		return nil, errors.New("only P-256 keys are supported")
	}
	return ssh.NewPublicKey(pub)
}

func authorizedKeyLine(key ssh.PublicKey, comment string) string {
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	comment = strings.Join(strings.Fields(comment), "-")
	if comment != "" {
		line += " " + comment
	}
	return line
}

// fingerprint is OpenSSH's SHA256 fingerprint format (unpadded base64).
func fingerprint(key ssh.PublicKey) string {
	sum := sha256.Sum256(key.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}
