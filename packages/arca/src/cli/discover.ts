import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARCA_ENVIRONMENTS } from "../config";
import type { ArcaEnvironment } from "../internal/types";

/**
 * The credential files `init` writes, found where the user is standing. This
 * is a convenience of the CLI and nothing else: `createArcaClient()` keeps
 * reading the environment, and the SDK never looks at the filesystem.
 */

/** Homologación first: it is where everyone starts. */
export const DISCOVERY_ORDER: readonly ArcaEnvironment[] = [
  "test",
  "production",
];

/** The environment a written answer names, or `undefined` when it names none. */
export function toEnvironment(value: string): ArcaEnvironment | undefined {
  return ARCA_ENVIRONMENTS.includes(value as ArcaEnvironment)
    ? (value as ArcaEnvironment)
    : undefined;
}

/** The certificate `init` tells the user to save for that environment. */
export function certificateFileName(environment: ArcaEnvironment): string {
  return `arca-${environment}.crt`;
}

/** The private key `init` writes for that environment. */
export function privateKeyFileName(environment: ArcaEnvironment): string {
  return `arca-${environment}.key`;
}

/** A complete pair, read from disk. */
export type DiscoveredCredentials = {
  environment: ArcaEnvironment;
  certificateFile: string;
  keyFile: string;
  certificatePem: string;
  privateKeyPem: string;
};

/**
 * What the directory holds. `ambiguous` means both environments are there and
 * only the user can say which one they meant; `incomplete` means half a pair,
 * which is what a directory looks like between `init` and ARCA's answer.
 */
export type CredentialDiscovery =
  | { kind: "none" }
  | { kind: "found"; credentials: DiscoveredCredentials }
  | { kind: "ambiguous"; files: string[] }
  | {
      kind: "incomplete";
      /** The file that is there, and the one that is not. */
      present: string;
      missing: string;
      /** Which half is missing, because the fix for each is different. */
      missingKind: "certificate" | "key";
    };

/**
 * Looks for `arca-<entorno>.crt` and `arca-<entorno>.key` in one directory.
 * With an environment already chosen, only that pair is considered.
 *
 * @throws When a file exists but cannot be read.
 */
export function discoverCredentials(
  directory: string,
  environment?: ArcaEnvironment
): CredentialDiscovery {
  const candidates = (
    environment === undefined ? DISCOVERY_ORDER : [environment]
  ).map((candidate) => {
    const certificateFile = certificateFileName(candidate);
    const keyFile = privateKeyFileName(candidate);
    return {
      environment: candidate,
      certificateFile,
      keyFile,
      hasCertificate: existsSync(resolve(directory, certificateFile)),
      hasKey: existsSync(resolve(directory, keyFile)),
    };
  });

  const complete = candidates.filter(
    (candidate) => candidate.hasCertificate && candidate.hasKey
  );
  if (complete.length > 1) {
    return {
      kind: "ambiguous",
      files: complete.map((candidate) => candidate.certificateFile),
    };
  }

  const [pair] = complete;
  if (pair !== undefined) {
    return {
      kind: "found",
      credentials: {
        environment: pair.environment,
        certificateFile: pair.certificateFile,
        keyFile: pair.keyFile,
        certificatePem: read(directory, pair.certificateFile),
        privateKeyPem: read(directory, pair.keyFile),
      },
    };
  }

  const half = candidates.find(
    (candidate) => candidate.hasCertificate || candidate.hasKey
  );
  if (half === undefined) {
    return { kind: "none" };
  }
  return half.hasCertificate
    ? {
        kind: "incomplete",
        present: half.certificateFile,
        missing: half.keyFile,
        missingKind: "key",
      }
    : {
        kind: "incomplete",
        present: half.keyFile,
        missing: half.certificateFile,
        missingKind: "certificate",
      };
}

function read(directory: string, file: string): string {
  return readFileSync(resolve(directory, file), "utf8").trim();
}
