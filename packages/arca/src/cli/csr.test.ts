import forge from "node-forge";
import { describe, expect, it } from "vitest";
import {
  buildArcaCsrSubject,
  createArcaCsrMaterial,
  privateKeyMatchesCertificate,
  readCertificateFacts,
} from "./csr";

const SUBJECT = {
  taxId: "20123456786",
  commonName: "facturas",
  organization: "Prueba SRL",
};

const material = createArcaCsrMaterial(SUBJECT);

describe("buildArcaCsrSubject", () => {
  it("orders the fields the way ARCA's guide writes them", () => {
    expect(buildArcaCsrSubject(SUBJECT)).toEqual([
      { name: "countryName", value: "AR" },
      { name: "organizationName", value: "Prueba SRL" },
      { name: "commonName", value: "facturas" },
      { name: "serialNumber", value: "CUIT 20123456786" },
    ]);
  });

  it("writes CUIT, one space and the eleven digits", () => {
    const serial = buildArcaCsrSubject(SUBJECT).at(-1);
    expect(serial?.value).toBe("CUIT 20123456786");
  });
});

describe("createArcaCsrMaterial", () => {
  it("writes the private key as an unencrypted PKCS#8 PEM", () => {
    expect(
      material.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----")
    ).toBe(true);
    expect(material.privateKeyPem).not.toContain("ENCRYPTED");
  });

  it("generates an RSA 2048 key", () => {
    const privateKey = forge.pki.privateKeyFromPem(material.privateKeyPem);
    expect(privateKey.n.bitLength()).toBe(2048);
  });

  it("writes a PKCS#10 request forge can parse", () => {
    expect(
      material.csrPem.startsWith("-----BEGIN CERTIFICATE REQUEST-----")
    ).toBe(true);
    const request = forge.pki.certificationRequestFromPem(material.csrPem);
    expect(
      request.subject.attributes.map((field) => [field.name, field.value])
    ).toEqual([
      ["countryName", "AR"],
      ["organizationName", "Prueba SRL"],
      ["commonName", "facturas"],
      ["serialNumber", "CUIT 20123456786"],
    ]);
  });

  it("signs the request with the generated key", () => {
    const request = forge.pki.certificationRequestFromPem(material.csrPem);
    expect(request.verify()).toBe(true);
  });

  it("never repeats a key across runs", () => {
    const other = createArcaCsrMaterial(SUBJECT);
    expect(other.privateKeyPem).not.toBe(material.privateKeyPem);
  });
});

describe("privateKeyMatchesCertificate", () => {
  it("accepts the key the certificate was issued for", () => {
    const pair = createSelfSigned();
    expect(
      privateKeyMatchesCertificate(pair.certificatePem, pair.privateKeyPem)
    ).toBe(true);
  });

  it("rejects a key from another certificate", () => {
    const pair = createSelfSigned();
    const other = createSelfSigned();
    expect(
      privateKeyMatchesCertificate(pair.certificatePem, other.privateKeyPem)
    ).toBe(false);
  });

  it("throws when a PEM does not parse", () => {
    expect(() => privateKeyMatchesCertificate("nope", "nope")).toThrow();
  });
});

describe("readCertificateFacts", () => {
  it("reads the validity window", () => {
    const notAfter = new Date("2027-09-05T00:00:00Z");
    const pair = createSelfSigned(notAfter);
    expect(readCertificateFacts(pair.certificatePem).notAfter.getTime()).toBe(
      notAfter.getTime()
    );
  });
});

function createSelfSigned(notAfter = new Date("2030-01-01T00:00:00Z")) {
  const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x01_00_01 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keyPair.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  certificate.validity.notAfter = notAfter;
  const attributes = [{ name: "commonName", value: "facturas" }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(keyPair.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKeyPem: forge.pki.privateKeyToPem(keyPair.privateKey),
  };
}

describe("readCertificateFacts taxId", () => {
  /** ARCA signs the CSR this CLI writes, so the subject comes back verbatim. */
  function issue(subject: forge.pki.CertificateField[]): string {
    const keyPair = forge.pki.rsa.generateKeyPair({
      bits: 2048,
      e: 0x01_00_01,
    });
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keyPair.publicKey;
    certificate.serialNumber = "01";
    certificate.validity.notBefore = new Date("2026-01-01T00:00:00Z");
    certificate.validity.notAfter = new Date("2028-01-01T00:00:00Z");
    certificate.setSubject(subject);
    certificate.setIssuer([{ name: "commonName", value: "ARCA" }]);
    certificate.sign(keyPair.privateKey, forge.md.sha256.create());
    return forge.pki.certificateToPem(certificate);
  }

  it("reads the CUIT ARCA keeps in serialNumber", () => {
    const pem = issue(buildArcaCsrSubject(SUBJECT));

    expect(readCertificateFacts(pem).taxId).toBe("20123456786");
  });

  it("says nothing when the subject has no serialNumber", () => {
    const pem = issue([{ name: "commonName", value: "facturas" }]);

    expect(readCertificateFacts(pem).taxId).toBeUndefined();
  });

  it("says nothing when serialNumber is not a CUIT", () => {
    const pem = issue([
      { name: "commonName", value: "facturas" },
      { name: "serialNumber", value: "12345" },
    ]);

    expect(readCertificateFacts(pem).taxId).toBeUndefined();
  });
});
