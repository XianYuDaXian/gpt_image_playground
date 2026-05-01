import path from 'node:path'
import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().optional(),
  WEB_DIST_DIR: z.string().optional(),
  APP_SECRET: z.string().min(16).default('change-this-secret-in-production'),
  CORS_ORIGIN: z.string().default('*'),
  UPSTREAM_API_URL: z.string().optional(),
  UPSTREAM_API_KEY: z.string().optional(),
  UPSTREAM_MODEL: z.string().optional(),
  UPSTREAM_API_MODE: z.enum(['images', 'responses']).optional(),
  UPSTREAM_TIMEOUT_SECONDS: z.coerce.number().int().positive().optional(),
  UPSTREAM_CODEX_CLI: z.string().optional(),
  VERSION_CHECK_REPO_OWNER: z.string().default('XianYuDaXian'),
  VERSION_CHECK_REPO_NAME: z.string().default('gpt_image_playground'),
})

const parsed = envSchema.parse(process.env)
const dataDir = parsed.DATA_DIR
  ? path.resolve(parsed.DATA_DIR)
  : path.resolve(process.cwd(), 'data')
const webDistDir = parsed.WEB_DIST_DIR
  ? path.resolve(parsed.WEB_DIST_DIR)
  : path.resolve(process.cwd(), '..', 'dist')

export const appConfig = {
  port: parsed.PORT,
  host: parsed.HOST,
  dataDir,
  webDistDir,
  dbPath: path.join(dataDir, 'app.db'),
  mediaDir: path.join(dataDir, 'media'),
  uploadsDir: path.join(dataDir, 'media', 'uploads'),
  masksDir: path.join(dataDir, 'media', 'masks'),
  outputsDir: path.join(dataDir, 'media', 'outputs'),
  thumbsDir: path.join(dataDir, 'media', 'thumbs'),
  appSecret: parsed.APP_SECRET,
  corsOrigin: parsed.CORS_ORIGIN,
  versionCheckRepoOwner: parsed.VERSION_CHECK_REPO_OWNER,
  versionCheckRepoName: parsed.VERSION_CHECK_REPO_NAME,
  bootstrapProvider: parsed.UPSTREAM_API_URL && parsed.UPSTREAM_API_KEY
    ? {
        baseUrl: parsed.UPSTREAM_API_URL,
        apiKey: parsed.UPSTREAM_API_KEY,
        model: parsed.UPSTREAM_MODEL ?? 'gpt-image-2',
        apiMode: parsed.UPSTREAM_API_MODE ?? 'images',
        timeoutSeconds: parsed.UPSTREAM_TIMEOUT_SECONDS ?? 300,
        codexCli: parsed.UPSTREAM_CODEX_CLI?.trim().toLowerCase() === 'true',
      }
    : null,
}
