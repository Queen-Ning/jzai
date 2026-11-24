import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppUninstallService } from './app-uninstall.service';
import { AppManifest } from '../validators/manifest.schema';

const appId = 'com.example.drawing.dimtuner';
const manifest: AppManifest = {
  manifestVersion: '1.0',
  appId,
  shortName: 'dim-tuner',
  nsPrefix: 'dt',
  name: { zh: '图纸识别' },
  version: '1.0.0',
  database: { schemaName: 'app_dim_tuner' },
};

describe('AppUninstallService', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-uninstall-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finishes uninstall when configuration artifacts remain', async () => {
    const dependencies = createDependencies(root, [
      'App configuration artifact remains at /app/main/config/agents/dt_dimension_classifier.yaml: EACCES',
    ]);

    await dependencies.service.uninstall(appId, { purgeData: true });

    expect(dependencies.registry.updateStatus).toHaveBeenCalledWith(appId, 'uninstalling');
    expect(dependencies.registry.updateStatus).not.toHaveBeenCalledWith(appId, 'failed');
    expect(dependencies.activation.deactivateApp).toHaveBeenCalledWith(appId, 'uninstall');
    expect(dependencies.activation.removeAgents).toHaveBeenCalledWith(manifest);
    expect(dependencies.activation.removeSkills).toHaveBeenCalledWith(manifest);
    expect(dependencies.activation.reloadRegistries).toHaveBeenCalled();
    expect(dependencies.pools.destroyPool).toHaveBeenCalledWith(appId);
    expect(dependencies.migrations.dropAll).toHaveBeenCalledWith(appId);
    expect(dependencies.schema.dropSchemaAndRole).toHaveBeenCalledWith(manifest);
    expect(fs.existsSync(dependencies.installDir)).toBe(false);
    expect(dependencies.registry.delete).toHaveBeenCalledWith(appId);
  });

  it('preserves recovery metadata when purgeData is false', async () => {
    const dependencies = createDependencies(root);

    await dependencies.service.uninstall(appId);

    expect(dependencies.migrations.dropAll).not.toHaveBeenCalled();
    expect(dependencies.schema.dropSchemaAndRole).not.toHaveBeenCalled();
    expect(dependencies.registry.updateStatus).toHaveBeenCalledWith(appId, 'uninstalled');
    expect(dependencies.registry.delete).not.toHaveBeenCalled();
  });

  it('removes the emptied versions/ and app root so a same-shortName app can be freshly installed', async () => {
    const appRoot = path.join(root, 'app-store', 'dim-tuner');
    const dependencies = createDependencies(root, [], path.join(appRoot, 'versions', '1.0.0'));

    await dependencies.service.uninstall(appId, { purgeData: true });

    expect(fs.existsSync(appRoot)).toBe(false);
    expect(fs.existsSync(path.join(root, 'app-store'))).toBe(true);
  });

  it('keeps the app root when it still holds other content', async () => {
    const appRoot = path.join(root, 'app-store', 'dim-tuner');
    const dependencies = createDependencies(root, [], path.join(appRoot, 'versions', '1.0.0'));
    fs.mkdirSync(path.join(appRoot, 'versions', '0.9.0'), { recursive: true });

    await dependencies.service.uninstall(appId, { purgeData: true });

    expect(fs.existsSync(dependencies.installDir)).toBe(false);
    expect(fs.existsSync(path.join(appRoot, 'versions', '0.9.0'))).toBe(true);
  });
});

function createDependencies(root: string, artifactWarnings: string[] = [], installDir = path.join(root, 'dim-tuner')) {
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'app.txt'), 'installed');

  const registry = {
    findOne: jest.fn().mockResolvedValue({ appId, manifest, installDir }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const schema = { dropSchemaAndRole: jest.fn().mockResolvedValue(undefined) };
  const migrations = { dropAll: jest.fn().mockResolvedValue(undefined) };
  const pools = {
    hasPool: jest.fn().mockReturnValue(true),
    destroyPool: jest.fn().mockResolvedValue(undefined),
  };
  const activation = {
    deactivateApp: jest.fn(),
    removePanels: jest.fn().mockResolvedValue(undefined),
    removeAgents: jest.fn().mockReturnValue(artifactWarnings),
    removeSkills: jest.fn().mockReturnValue([]),
    reloadRegistries: jest.fn(),
  };
  const service = new AppUninstallService(
    {} as any,
    registry as any,
    schema as any,
    migrations as any,
    pools as any,
    activation as any,
    { removeForApp: jest.fn().mockResolvedValue(undefined) } as any,
    { deleteAllSecrets: jest.fn().mockResolvedValue(undefined) } as any,
  );

  return { service, installDir, registry, schema, migrations, pools, activation };
}
