import * as ghCore from "@actions/core";
import * as crypto from "crypto";
import * as fs from "fs";

import { HttpClient } from "../util/utils";
import { ClientFile } from "../util/types";
import { getDirContents } from "../client-finder/directory-finder";
import { isOCV3 } from "../client-finder/oc-3-finder";

const SHA_FILENAMES = [ "sha256sum.txt", "SHA256_SUM" ];
type HashAlgorithm = "md5" | "sha256";

/**
 * Verify that the downloadedArchive has the hash it should have according to the hash file in the online directory.
 * @returns void, and throws an error if the verification fails.
 */
export async function verifyHash(downloadedArchivePath: string, clientFile: ClientFile): Promise<void> {
    const correctHash = await getOnlineHash(clientFile);
    if (correctHash == null) {
        return;
    }

    const actualHash = await hashFile(downloadedArchivePath, correctHash.algorithm);
    ghCore.debug(`Correct hash for ${clientFile.archiveFilename} is ${correctHash.hash}`);
    ghCore.debug(`Actual hash for ${clientFile.archiveFilename} is  ${actualHash}`);

    if (correctHash.hash !== actualHash) {
        throw new Error(
            `${correctHash.algorithm} hash for ${downloadedArchivePath} downloaded from ${clientFile.archiveFileUrl} `
            + `did not match the hash downloaded from ${correctHash.hashFileUrl}.`
            + `\nExpected: "${correctHash.hash}"\nReceived: "${actualHash}"`,
        );
    }

    ghCore.info(`${correctHash.algorithm} verification of ${clientFile.archiveFilename} succeeded.`);
}

/**
 * @returns The hash for the given file, using the given algorithm.
 */
async function hashFile(file: string, algorithm: HashAlgorithm): Promise<string> {
    ghCore.debug(`${algorithm} hashing ${file}...`);
    const hash = crypto.createHash(algorithm).setEncoding("hex");

    return new Promise<string>((resolve, reject) => {
        fs.createReadStream(file)
            .on("error", reject)
            .pipe(hash)
            .once("finish", () => {
                hash.end();
                resolve(hash.read());
            });
    });
}

type HashFileContents = { algorithm: HashAlgorithm, hash: string, hashFileUrl: string };

/**
 * Fetches the hashes for the clientFile's directory, then extracts and returns the hash for the given clientFile.
 */
async function getOnlineHash(clientFile: ClientFile): Promise<HashFileContents | undefined> {
    const directoryContents = await getDirContents(clientFile.directoryUrl);

    // this is the hash kamel uses - the others use the sha256 txt file
    const md5Filename = `${clientFile.archiveFilename}.md5`;
    const matchedShaFilename = directoryContents.find((file) => SHA_FILENAMES.includes(file));

    let algorithm: HashAlgorithm;
    let hashFilename: string;
    if (matchedShaFilename) {
        algorithm = "sha256";
        hashFilename = matchedShaFilename;
    }
    else if (directoryContents.includes(md5Filename)) {
        algorithm = "md5";
        hashFilename = md5Filename;
    }
    else {
        // oc v3 lacks hash files; others should have them.
        if (isOCV3(clientFile.clientName, clientFile.versionRange)) {
            ghCore.info("Hash verification is not available for oc v3.");
        }
        else {
            // should this fail the install?
            // with the warning behaviour, removing the hash file would mean the executables could be compromised.
            // but, at that point, they could also just edit the hashes to match the malicious executables.
            ghCore.warning(`No hash file found under ${clientFile.directoryUrl} for `
                + `${clientFile.archiveFilename} - skipping verification.`);
        }
        return undefined;
    }

    const hashFileUrl = `${clientFile.directoryUrl}/${hashFilename}`;
    ghCore.info(`⬇️ Downloading hash file ${hashFileUrl}`);

    const hashFileRes = await HttpClient.get(hashFileUrl, { "Content-Type": "text/plain" });
    const hashFileContents = await hashFileRes.readBody();
    const hash = parseHashFile(hashFileContents, clientFile.archiveFilename);

    return { algorithm, hash, hashFileUrl };
}

/**
 * @returns The hash for fileToHash, as extracted from the hashFileContents.
 */
function parseHashFile(hashFileContents: string, fileToHash: string): string {
    // the hash file format is:
    // ${hash} ${filename}\n
    // for all filenames in the directory.

    // lines is an array of arrays where the outer array is lines and the inner array is space-split tokens.
    const lines = hashFileContents.split("\n").map((line) => line.split(/\s+/));

    // so, line[0] is the sha and line[1] is the filename
    const fileLine = lines.find((line) => line[1] === fileToHash);
    if (fileLine == null) {
        throw new Error(`Did not find file "${fileToHash}" in the given hash file`);
    }

    const hash = fileLine[0];
    return hash;
}
