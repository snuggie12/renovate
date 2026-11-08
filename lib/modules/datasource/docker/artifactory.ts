import { z } from 'zod/v4';
import { logger } from '../../../logger/index.ts';
import { coerceArray } from '../../../util/array.ts';
import * as hostRules from '../../../util/host-rules.ts';
import { Http } from '../../../util/http/index.ts';
import { regEx } from '../../../util/regex.ts';
import { LooseArray } from '../../../util/schema-utils/index.ts';
import { MaybeTimestamp, type Timestamp } from '../../../util/timestamp.ts';
import { joinUrlParts, parseUrl } from '../../../util/url.ts';
import { dockerDatasourceId } from './common.ts';
import type { RegistryTimestampsConfig } from './types.ts';

const http = new Http(dockerDatasourceId);

const leadingSlashRegex = regEx(/^\//);

/** Files Artifactory stores in each tag folder, for single and multi-arch images */
const manifestFileNames = new Set(['manifest.json', 'list.manifest.json']);

const FileList = z.object({
  files: LooseArray(
    z.object({
      uri: z.string(),
      lastModified: MaybeTimestamp,
    }),
  ),
});

interface ArtifactoryLocation {
  repoKey: string;
  imagePath: string;
}

/**
 * Returns where an image could be stored in Artifactory: in the configured `artifactoryRepoKey`, or else per the repository path and subdomain Docker access methods.
 */
function getCandidateLocations(
  registryHost: string,
  dockerRepository: string,
): ArtifactoryLocation[] {
  const { artifactoryRepoKey } = hostRules.find({
    hostType: dockerDatasourceId,
    url: registryHost,
  });
  if (artifactoryRepoKey) {
    return [{ repoKey: artifactoryRepoKey, imagePath: dockerRepository }];
  }

  const candidates: ArtifactoryLocation[] = [];

  const [firstSegment, ...rest] = dockerRepository.split('/');
  if (rest.length) {
    candidates.push({ repoKey: firstSegment, imagePath: rest.join('/') });
  }

  // The subdomain method serves each repository from `<repoKey>.<artifactory host>`
  const hostLabels = coerceArray(parseUrl(registryHost)?.hostname.split('.'));
  if (hostLabels.length > 3) {
    candidates.push({ repoKey: hostLabels[0], imagePath: dockerRepository });
  }

  return candidates;
}

async function getManifestTimestamps(
  apiUrl: string,
  { repoKey, imagePath }: ArtifactoryLocation,
): Promise<Map<string, Timestamp> | null> {
  const url = `${joinUrlParts(apiUrl, 'api/storage', repoKey, imagePath)}?list&deep=1&depth=2&listFolders=0`;
  const { val: fileList, err } = await http.getJsonSafe(url, FileList).unwrap();
  if (err) {
    logger.trace(
      { err },
      `Docker: no Artifactory file list for ${repoKey}/${imagePath}`,
    );
    return null;
  }

  const timestamps = new Map<string, Timestamp>();
  for (const { uri, lastModified } of fileList.files) {
    const [tag, fileName] = uri.replace(leadingSlashRegex, '').split('/');
    if (lastModified && manifestFileNames.has(fileName)) {
      timestamps.set(tag, lastModified);
    }
  }
  return timestamps;
}

/**
 * Returns the time each tag's manifest was last modified, as recorded by Artifactory.
 */
export async function getArtifactoryTagTimestamps({
  registryHost,
  dockerRepository,
  registryApiUrl,
}: RegistryTimestampsConfig): Promise<Map<string, Timestamp> | null> {
  const apiUrl = registryApiUrl ?? joinUrlParts(registryHost, 'artifactory');
  for (const location of getCandidateLocations(
    registryHost,
    dockerRepository,
  )) {
    const timestamps = await getManifestTimestamps(apiUrl, location);
    if (timestamps) {
      return timestamps;
    }
  }

  logger.debug(
    `Docker: no Artifactory repository found for ${dockerRepository} at ${apiUrl}`,
  );
  return null;
}
