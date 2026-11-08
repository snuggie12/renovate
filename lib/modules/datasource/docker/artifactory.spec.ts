import { hostRules } from '~test/host-rules.ts';
import * as httpMock from '~test/http-mock.ts';
import { getPkgReleases } from '../index.ts';
import { getArtifactoryTagTimestamps } from './artifactory.ts';
import { DockerDatasource } from './index.ts';

const listQuery = { list: '', deep: '1', depth: '2', listFolders: '0' };

describe('modules/datasource/docker/artifactory', () => {
  beforeEach(() => {
    hostRules.clear();
  });

  it('returns manifest times for the repository path access method', async () => {
    httpMock
      .scope('https://artifactory.example.com')
      .get('/artifactory/api/storage/docker-local/team/app')
      .query(listQuery)
      .reply(200, {
        files: [
          {
            uri: '/1.0.0/manifest.json',
            lastModified: '2026-01-01T00:00:00.000Z',
          },
          {
            uri: '/1.0.0/sha256__abc',
            lastModified: '2026-03-01T00:00:00.000Z',
          },
          {
            uri: '/2.0.0/list.manifest.json',
            lastModified: '2026-02-01T00:00:00.000+01:00',
          },
          { uri: '/3.0.0/manifest.json', lastModified: null },
        ],
      });

    const res = await getArtifactoryTagTimestamps({
      registryHost: 'https://artifactory.example.com',
      dockerRepository: 'docker-local/team/app',
    });

    expect(res).toEqual(
      new Map([
        ['1.0.0', '2026-01-01T00:00:00.000Z'],
        ['2.0.0', '2026-01-31T23:00:00.000Z'],
      ]),
    );
  });

  it('falls back to the subdomain access method, using registryApiUrl', async () => {
    httpMock
      .scope('https://artifactory.example.com')
      .get('/api/storage/team/app')
      .query(listQuery)
      .reply(404, { errors: [{ status: 404, message: 'Not Found' }] })
      .get('/api/storage/docker-local/team/app')
      .query(listQuery)
      .reply(200, {
        files: [
          {
            uri: '/1.0.0/manifest.json',
            lastModified: '2026-01-01T00:00:00.000Z',
          },
        ],
      });

    const res = await getArtifactoryTagTimestamps({
      registryHost: 'https://docker-local.artifactory.example.com',
      dockerRepository: 'team/app',
      registryApiUrl: 'https://artifactory.example.com',
    });

    expect(res).toEqual(new Map([['1.0.0', '2026-01-01T00:00:00.000Z']]));
  });

  it('uses only the configured artifactoryRepoKey with the full image path', async () => {
    hostRules.add({
      matchHost: 'helm.example.com',
      registryType: 'artifactory',
      artifactoryRepoKey: 'helm-oci',
    });
    httpMock
      .scope('https://artifactory.example.com')
      .get('/artifactory/api/storage/helm-oci/team/chart')
      .query(listQuery)
      .reply(200, {
        files: [
          {
            uri: '/1.0.0/manifest.json',
            lastModified: '2026-01-01T00:00:00.000Z',
          },
        ],
      });

    const res = await getArtifactoryTagTimestamps({
      registryHost: 'https://helm.example.com',
      dockerRepository: 'team/chart',
      registryApiUrl: 'https://artifactory.example.com/artifactory',
    });

    expect(res).toEqual(new Map([['1.0.0', '2026-01-01T00:00:00.000Z']]));
  });

  it('returns null when no repository matches', async () => {
    const res = await getArtifactoryTagTimestamps({
      registryHost: 'https://artifactory.example.com',
      dockerRepository: 'app',
    });

    expect(res).toBeNull();
  });

  it('sets release timestamps in getReleases using the registry credentials', async () => {
    vi.stubEnv('RENOVATE_X_DOCKER_HUB_DISABLE_LABEL_LOOKUP', 'true');
    hostRules.add({
      matchHost: 'artifactory.example.com',
      registryType: 'artifactory',
      username: 'renovate',
      password: 'secret',
    });
    httpMock
      .scope('https://artifactory.example.com')
      .get('/v2/docker-local/app/tags/list?n=10000')
      .reply(401, '', { 'www-authenticate': 'Basic realm="Artifactory Realm"' })
      .get('/v2/docker-local/app/tags/list?n=10000')
      .reply(200, { tags: ['1.0.0', '2.0.0'] })
      .get('/artifactory/api/storage/docker-local/app')
      .query(listQuery)
      .basicAuth({ user: 'renovate', pass: 'secret' })
      .reply(200, {
        files: [
          {
            uri: '/2.0.0/manifest.json',
            lastModified: '2026-02-01T00:00:00.000Z',
          },
        ],
      })
      .get('/v2/')
      .reply(200)
      .get('/v2/docker-local/app/manifests/2.0.0')
      .reply(404);

    const res = await getPkgReleases({
      datasource: DockerDatasource.id,
      packageName: 'artifactory.example.com/docker-local/app',
    });

    expect(res?.releases).toEqual([
      { version: '1.0.0' },
      { version: '2.0.0', releaseTimestamp: '2026-02-01T00:00:00.000Z' },
    ]);
  });

  it('sets release timestamps in getReleases with a separate API host and its credentials', async () => {
    vi.stubEnv('RENOVATE_X_DOCKER_HUB_DISABLE_LABEL_LOOKUP', 'true');
    hostRules.add({
      matchHost: 'docker.example.com',
      registryType: 'artifactory',
      artifactoryRepoKey: 'docker',
      registryApiUrl: 'https://artifactory.example.com/artifactory',
      username: 'puller',
      password: 'pull-secret',
    });
    hostRules.add({
      matchHost: 'artifactory.example.com',
      username: 'api-user',
      password: 'api-secret',
    });
    httpMock
      .scope('https://docker.example.com')
      .get('/v2/infra/app/tags/list?n=10000')
      .reply(401, '', { 'www-authenticate': 'Basic realm="Artifactory Realm"' })
      .get('/v2/infra/app/tags/list?n=10000')
      .basicAuth({ user: 'puller', pass: 'pull-secret' })
      .reply(200, { tags: ['1.0.0', '2.0.0'] })
      .get('/v2/')
      .reply(200)
      .get('/v2/infra/app/manifests/2.0.0')
      .reply(404);
    httpMock
      .scope('https://artifactory.example.com')
      .get('/artifactory/api/storage/docker/infra/app')
      .query(listQuery)
      .basicAuth({ user: 'api-user', pass: 'api-secret' })
      .reply(200, {
        files: [
          {
            uri: '/2.0.0/list.manifest.json',
            lastModified: '2026-02-01T00:00:00.000Z',
          },
        ],
      });

    const res = await getPkgReleases({
      datasource: DockerDatasource.id,
      packageName: 'docker.example.com/infra/app',
    });

    expect(res?.releases).toEqual([
      { version: '1.0.0' },
      { version: '2.0.0', releaseTimestamp: '2026-02-01T00:00:00.000Z' },
    ]);
  });
});
