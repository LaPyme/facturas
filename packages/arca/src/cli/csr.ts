import forge from "node-forge";

const RSA_MODULUS_BITS = 2048;
const RSA_PUBLIC_EXPONENT = 0x01_00_01;
/** How ARCA writes the CUIT in the subject, with a literal space after `CUIT`. */
const SUBJECT_TAX_ID = /^CUIT\s+(\d{11})$/;

/** The distinguished name ARCA expects on a certificate signing request. */
export type ArcaCsrSubject = {
  /** 11-digit CUIT. Goes to `serialNumber` as `CUIT <cuit>`. */
  taxId: string;
  /** Alias for the certificate. Goes to `CN`. */
  commonName: string;
  /** Organization. Goes to `O`; defaults to the CUIT when the caller has none. */
  organization: string;
};

/** An unencrypted PKCS#8 private key and the PKCS#10 request that pairs with it. */
export type ArcaCsrMaterial = {
  privateKeyPem: string;
  csrPem: string;
};

/** What a certificate says about itself, with no credential in sight. */
export type CertificateFacts = {
  notBefore: Date;
  notAfter: Date;
  /** The CUIT in `serialNumber`, when ARCA wrote one there. */
  taxId?: string;
};

/** Builds the subject in the order ARCA's manual writes it: C, O, CN, serialNumber. */
export function buildArcaCsrSubject(
  subject: ArcaCsrSubject
): forge.pki.CertificateField[] {
  return [
    { name: "countryName", value: "AR" },
    { name: "organizationName", value: subject.organization },
    { name: "commonName", value: subject.commonName },
    { name: "serialNumber", value: `CUIT ${subject.taxId}` },
  ];
}

/** Generates an RSA 2048 key and the CSR to upload in ARCA. Pure and offline. */
export function createArcaCsrMaterial(
  subject: ArcaCsrSubject
): ArcaCsrMaterial {
  const keyPair = forge.pki.rsa.generateKeyPair({
    bits: RSA_MODULUS_BITS,
    e: RSA_PUBLIC_EXPONENT,
  });
  const privateKeyPem = toPkcs8Pem(keyPair.privateKey);
  const request = forge.pki.createCertificationRequest();
  request.publicKey = keyPair.publicKey;
  request.setSubject(buildArcaCsrSubject(subject));
  request.sign(keyPair.privateKey, forge.md.sha256.create());

  return {
    privateKeyPem,
    csrPem: forge.pki.certificationRequestToPem(request),
  };
}

/** Serializes an RSA private key as an unencrypted PKCS#8 PEM. */
export function toPkcs8Pem(privateKey: forge.pki.rsa.PrivateKey): string {
  return forge.pki.privateKeyInfoToPem(
    forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(privateKey))
  );
}

/**
 * Reads the validity window and the CUIT of a certificate PEM. Throws on
 * anything that is not a certificate. ARCA issues against the CSR this CLI
 * writes, so the CUIT comes back in `serialNumber` as `CUIT <11 dígitos>`;
 * a certificate from somewhere else may carry nothing there.
 */
export function readCertificateFacts(certificatePem: string): CertificateFacts {
  const certificate = forge.pki.certificateFromPem(certificatePem);
  const taxId = readSubjectTaxId(certificate);
  return {
    notBefore: certificate.validity.notBefore,
    notAfter: certificate.validity.notAfter,
    ...(taxId === undefined ? {} : { taxId }),
  };
}

function readSubjectTaxId(
  certificate: forge.pki.Certificate
): string | undefined {
  const field = certificate.subject.getField({ name: "serialNumber" }) as {
    value?: unknown;
  } | null;
  if (typeof field?.value !== "string") {
    return undefined;
  }
  return SUBJECT_TAX_ID.exec(field.value.trim())?.[1];
}

/**
 * True when the private key is the one the certificate was issued for: same
 * RSA modulus and same public exponent. Throws when either PEM does not parse.
 */
export function privateKeyMatchesCertificate(
  certificatePem: string,
  privateKeyPem: string
): boolean {
  const certificate = forge.pki.certificateFromPem(certificatePem);
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const certificateKey = certificate.publicKey as forge.pki.rsa.PublicKey;

  if (certificateKey?.n === undefined || certificateKey.e === undefined) {
    return false;
  }

  return (
    certificateKey.n.compareTo(privateKey.n) === 0 &&
    certificateKey.e.compareTo(privateKey.e) === 0
  );
}
