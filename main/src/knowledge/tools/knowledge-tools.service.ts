import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import { DbService } from '../../db/db.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import { loadKnowledgeConfig, KnowledgeConfig } from '../knowledge.config';
import { SpacesService, KbSpace, ENTERPRISE_SPACE_SLUG } from '../spaces.service';
import { KbAccessService } from '../kb-access.service';
import { VaultFsService, VaultFS } from '../vaultfs/vaultfs.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import {
  SearchHandler, ReadHandler, WriteHandler, DeleteHandler, QueryHandler,
  HandlerContext, ContentBlock,
} from './handlers';
import { MAX_SEARCH } from './helpers';

/** 工具调用上下文（原 MCP scopes 参数的内部化） */
export interface KnowledgeCallContext {
  userId?: string;
  userEmail?: string;
  /** 分类 scope 快照；'ADMIN_ALL' 或字符串数组（可含 'ADMIN_ALL'） */
  scopes?: string[] | 'ADMIN_ALL';
  /** APP 身份（APP 空间读写判定） */
  appId?: string;
}

/** Lightweight tool definition（对齐原 McpTool） */
export interface McpTool {
  name: string;
  description: string;
  parameters: any;
  execute: (
    id: string,
    params: any,
    ctx?: KnowledgeCallContext,
  ) => Promise<{ content: { type: string; text: string }[]; details?: any }>;
}

/** KB analytics event（对齐原 KbAnalyticsEvent） */
export interface KbAnalyticsEvent {
  type: string;
  timestamp: Date;
  query?: string;
  tags?: string | null;
  scope?: string;
  hit?: boolean;
  [key: string]: any;
}

const SEARCH_TOOL_DESCRIPTION =
  'Browse or search the knowledge vault.\n\n' +
  'Sources (raw documents) live at `/`. Wiki pages (LLM-compiled) live at `/wiki/`.\n\n' +
  'Modes:\n' +
  '- list: browse files and folders\n' +
  '- search: keyword search across document content (searches chunks for precise results with page numbers)\n' +
  '- references: query the citation/link graph for a document\n' +
  '- digest: compact knowledge base summary (categories, tags, recent docs) for context injection\n\n' +
  'Use `path` to scope: `*` for root, `/wiki/**` for wiki only, `*.pdf` for PDFs, etc.\n' +
  'Use `tags` to filter by document tags.';

const READ_TOOL_DESCRIPTION =
  'Read document content from the knowledge vault.\n\n' +
  'Accepts a single file path OR a glob pattern to batch-read multiple files. ' +
  'For PDFs and office docs, use `pages` to read specific page ranges. ' +
  'Set `include_images=true` to include embedded images (off by default).';

const WRITE_TOOL_DESCRIPTION =
  'Create or edit notes and wiki pages in the knowledge vault.\n\n' +
  'Wiki pages should be created under `/wiki/` and should cite their sources using ' +
  'markdown footnotes (e.g. `[^1]: paper.pdf, p.3`).\n\n' +
  'Commands: create (title and tags REQUIRED) / str_replace / append.';

const DELETE_TOOL_DESCRIPTION =
  'Delete documents or wiki pages from the knowledge vault.\n\n' +
  'Provide a path to delete a single file, or a glob pattern to delete multiple. ' +
  'overview.md and log.md are structural pages and cannot be deleted.';

const QUERY_TOOL_DESCRIPTION =
  'Retrieve knowledge from the wiki — returns full document content, not just snippets.';

/** 内部工具目录（guide 已移除，对齐原 kbs MCP 工具集） */
const TOOL_DEFS: Array<{ name: string; description: string; inputSchema: any }> = [
  {
    name: 'search',
    description: SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        knowledge_base: { type: 'string', description: '空间 slug（默认企业空间）' },
        mode: { type: 'string', enum: ['list', 'search', 'references', 'digest'], default: 'list' },
        query: { type: 'string', default: '' },
        path: { type: 'string', default: '*' },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number', default: 10 },
        user_email: { type: 'string', default: '' },
        scopes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'read',
    description: READ_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        knowledge_base: { type: 'string' },
        path: { type: 'string' },
        pages: { type: 'string', default: '' },
        sections: { type: 'array', items: { type: 'string' } },
        include_images: { type: 'boolean', default: false },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: WRITE_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        knowledge_base: { type: 'string' },
        command: { type: 'string', enum: ['create', 'str_replace', 'append'] },
        path: { type: 'string', default: '/' },
        title: { type: 'string', default: '' },
        content: { type: 'string', default: '' },
        tags: { type: 'array', items: { type: 'string' } },
        date_str: { type: 'string', default: '' },
        old_text: { type: 'string', default: '' },
        new_text: { type: 'string', default: '' },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['command'],
    },
  },
  {
    name: 'delete',
    description: DELETE_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        knowledge_base: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'query',
    description: QUERY_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        knowledge_base: { type: 'string' },
        query: { type: 'string', default: '' },
        tags: { type: 'array', items: { type: 'string' } },
        scope: { type: 'string', enum: ['all', 'wiki', 'sources'], default: 'wiki' },
        limit: { type: 'number', default: 5 },
        include_references: { type: 'boolean', default: false },
        user_email: { type: 'string', default: '' },
      },
    },
  },
  {
    name: 'ping',
    description: 'Check if the knowledge service is alive.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/**
 * KnowledgeToolsService — 知识库工具执行层（替代原 McpToolsService 的 MCP 客户端）。
 * 工具全部内部直连 VaultFS/Taxonomy，无网络传输。
 */
@Injectable()
export class KnowledgeToolsService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeToolsService.name);
  private config: KnowledgeConfig;
  private kbEventListeners: Array<(event: KbAnalyticsEvent) => void> = [];

  // Enterprise Mind layer cache（对齐原 P0-5：避免 agent 创建时重复读取）
  private knowledgeLayerCache = new Map<string, { value: string | null; expiry: number }>();
  private static readonly KNOWLEDGE_LAYER_CACHE_TTL_MS = 5 * 60 * 1000;

  // 工具写入的分类路径解析缓存（同一批工具调用内避免重复查库）
  private categoryPathCache = new Map<string, { id: string | null; expiry: number }>();
  private enterpriseSpaceIdCache: { id: string; expiry: number } | null = null;
  private static readonly CATEGORY_PATH_CACHE_TTL_MS = 30 * 1000;

  constructor(
    private readonly db: DbService,
    private readonly workspace: WorkspaceService,
    private readonly spaces: SpacesService,
    private readonly kbAccess: KbAccessService,
    private readonly vaultFs: VaultFsService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  async onModuleInit() {
    this.config = loadKnowledgeConfig(this.workspace.getKnowledgeBaseDir());
    await this.spaces.ensureEnterpriseSpace();
    this.logger.log('Knowledge service initialized (internal, spaces ready)');
  }

  /** Register a listener for KB analytics events (used by AnalyticsService) */
  onKbEvent(fn: (event: KbAnalyticsEvent) => void) {
    this.kbEventListeners.push(fn);
  }

  private emitKbEvent(type: string, data: Record<string, any>) {
    const event: KbAnalyticsEvent = { type, timestamp: new Date(), ...data };
    for (const fn of this.kbEventListeners) {
      try { fn(event); } catch { /* ignore listener errors */ }
    }
  }

  /** 内部服务始终可用（DB 直连） */
  isAvailable(): boolean {
    return true;
  }

  /** Explicitly invalidate the KB layer cache (e.g. after admin edits) */
  invalidateKnowledgeLayerCache() {
    this.knowledgeLayerCache.clear();
    this.logger.debug('Knowledge layer cache invalidated');
  }

  private getCachedKnowledgeLayer(key: string): string | null | undefined {
    const cached = this.knowledgeLayerCache.get(key);
    if (!cached) return undefined;
    if (cached.expiry < Date.now()) {
      this.knowledgeLayerCache.delete(key);
      return undefined;
    }
    return cached.value;
  }

  private setCachedKnowledgeLayer(key: string, value: string | null) {
    this.knowledgeLayerCache.set(key, {
      value,
      expiry: Date.now() + KnowledgeToolsService.KNOWLEDGE_LAYER_CACHE_TTL_MS,
    });
  }

  // ── 空间与权限解析 ──────────────────────────────────────────────────────

  private handlerCtx(): HandlerContext {
    return { appUrl: this.config.appUrl, taxonomy: this.taxonomy };
  }

  /**
   * 解析空间 + 构造 VaultFS + 解析 scopes。
   * 返回 null 表示空间不可见（对调用方表现为 not found）。
   */
  private async resolveVault(
    knowledgeBase: string | undefined,
    callCtx?: KnowledgeCallContext,
  ): Promise<{ space: KbSpace; fs: VaultFS; scopes: Set<string> | null; writable: boolean; userId: string; isAdmin: boolean } | null> {
    const space = await this.spaces.resolve(knowledgeBase || ENTERPRISE_SPACE_SLUG);
    if (!space) return null;

    const userId = callCtx?.userId || '';
    // APP 身份：仅对自有 APP 空间追加写权限；其余空间回落到用户语义判定
    // （APP agent 常以用户身份操作企业空间，如 wiki_compiler 编译入 ent-default）
    if (callCtx?.appId && space.type === 'app' && space.owner_app_id === callCtx.appId) {
      return {
        space,
        fs: this.vaultFs.forSpace(space, this.spaces.rootFor(space.slug), userId),
        scopes: null,
        writable: true,
        userId,
        isAdmin: false,
      };
    }

    const isAdmin = userId ? await this.kbAccess.isAdmin(userId) : false;
    if (!this.spaces.canRead(space, userId, isAdmin)) return null;

    const fs = this.vaultFs.forSpace(space, this.spaces.rootFor(space.slug), userId);

    let scopes: Set<string> | null;
    if (callCtx?.scopes !== undefined) {
      const s = callCtx.scopes;
      scopes = s === 'ADMIN_ALL' || s.includes('ADMIN_ALL') ? null : new Set(s);
    } else if (isAdmin) {
      scopes = null;
    } else {
      scopes = await fs.accessibleScopes(userId || null, null);
    }

    const writable = this.spaces.canWrite(space, userId, isAdmin);
    return { space, fs, scopes, writable, userId, isAdmin };
  }

  /**
   * 按目标路径校验分类级写权限（智能体 write / delete 工具用）。
   * - 管理员 → true
   * - /wiki/_personal/ → true（个人空间按 userId 隔离，文件系统层已限制）
   * - 写 /wiki/pending/ 且无来源路径 → 登录用户即可（知识建议箱，非正式知识）
   * - 写 /wiki/_drafts/ 或 /wiki/pending/ 且带来源路径 → 按来源路径的分类判权（编译场景，多来源需全部满足）
   * - 否则按目标路径判权；解析不到分类 → false（非管理员不可写未分类）
   * - write 需 editor/admin，delete 需 admin
   */
  private async checkPathWritable(
    targetPath: string,
    userId: string,
    isAdmin: boolean,
    action: 'write' | 'delete',
    sourcePath?: string | string[],
  ): Promise<boolean> {
    if (isAdmin) return true;

    const raw = String(targetPath || '').replace(/\\/g, '/');
    if (raw.startsWith('/wiki/_personal/') || raw.startsWith('wiki/_personal/')) return true;

    const target = this.normalizeToolPath(raw);
    if (!target) return false;

    const sources = (Array.isArray(sourcePath) ? sourcePath : sourcePath ? [sourcePath] : [])
      .map((p) => this.normalizeToolPath(p))
      .filter((p): p is string => !!p);

    // 知识建议箱：pending 下无来源路径时，登录用户即可提交（正式写入仍需分类角色）
    if (action === 'write' && sources.length === 0 && target.startsWith('/wiki/pending/')) {
      return !!userId;
    }
    if (!userId) return false;

    // 编译草稿：目标本身不挂分类，按来源 raw 目录的分类判权
    const useSource = sources.length > 0
      && (target.startsWith('/wiki/_drafts/') || target.startsWith('/wiki/pending/'));
    const classifyPaths = useSource ? sources : [target];

    const spaceId = await this.getEnterpriseSpaceId();
    if (!spaceId) return false;

    const scopes = await this.kbAccess.getAccessibleScopesWithRole(userId);
    if (scopes === 'ADMIN_ALL') return true;

    for (const classifyPath of classifyPaths) {
      const categoryId = await this.resolveCategoryIdByToolPath(classifyPath, spaceId);
      if (!categoryId) return false;
      const hit = scopes.find((s) => s.categoryId === categoryId);
      if (!hit) return false;
      const ok = action === 'delete'
        ? hit.role === 'admin'
        : hit.role === 'editor' || hit.role === 'admin';
      if (!ok) return false;
    }
    return true;
  }

  /** 工具路径规范化：统一分隔符、归一化 . / ..，返回以 / 开头的绝对路径；非法返回 null */
  private normalizeToolPath(p: string): string | null {
    const raw = String(p || '').replace(/\\/g, '/');
    const normalized = path.posix.normalize('/' + raw.replace(/^\/+/, ''));
    const segments = normalized.split('/').filter((s) => s.length > 0);
    if (segments.includes('..')) return null;
    return '/' + segments.join('/') + (segments.length > 0 ? '/' : '');
  }

  /** 分类 path 最长前缀匹配（带 30s 缓存，避免同批工具调用重复查库） */
  private async resolveCategoryIdByToolPath(toolPath: string, spaceId: string): Promise<string | null> {
    const segments = toolPath.split('/').filter((s) => s.length > 0);
    if (segments.length > 0 && ['wiki', 'raw', 'sources'].includes(segments[0])) segments.shift();
    if (segments.length === 0) return null;
    const categoryPath = '/' + segments.join('/');

    const key = `${spaceId}:${categoryPath}`;
    const cached = this.categoryPathCache.get(key);
    if (cached && cached.expiry > Date.now()) return cached.id;

    let found: string | null = null;
    for (let i = segments.length; i > 0; i--) {
      const candidate = '/' + segments.slice(0, i).join('/');
      const { rows } = await this.db.query(
        'SELECT id FROM jz_kb_categories WHERE path = $1 AND space_id = $2',
        [candidate, spaceId],
      );
      if (rows.length > 0) {
        found = String(rows[0].id);
        break;
      }
    }
    this.categoryPathCache.set(key, {
      id: found,
      expiry: Date.now() + KnowledgeToolsService.CATEGORY_PATH_CACHE_TTL_MS,
    });
    return found;
  }

  private async getEnterpriseSpaceId(): Promise<string | null> {
    if (this.enterpriseSpaceIdCache && this.enterpriseSpaceIdCache.expiry > Date.now()) {
      return this.enterpriseSpaceIdCache.id;
    }
    const space = await this.spaces.resolve(ENTERPRISE_SPACE_SLUG);
    if (!space) return null;
    this.enterpriseSpaceIdCache = {
      id: space.id,
      expiry: Date.now() + KnowledgeToolsService.CATEGORY_PATH_CACHE_TTL_MS,
    };
    return space.id;
  }

  /** APP 空间（自有）与个人空间不参与分类授权（前者按 appId、后者按属主隔离） */
  private isCategoryExemptSpace(space: KbSpace): boolean {
    return space.type === 'app' || space.subtype === 'personal';
  }

  /** 编译来源目录集合（去重）；用于按来源分类判权 */
  private distinctSourceDirs(sources: any[]): string[] {
    const dirs = new Set<string>();
    for (const d of sources) {
      const p = String(d?.path || '').replace(/\\/g, '/');
      if (p) dirs.add(p);
    }
    return [...dirs];
  }

  /** 目录 → 分类可读名（用于跳过提示）；解析不到分类时退化为目录路径 */
  private async categoryLabelForDir(dir: string): Promise<string> {
    const spaceId = await this.getEnterpriseSpaceId();
    if (!spaceId) return dir;
    const categoryId = await this.resolveCategoryIdByToolPath(dir, spaceId);
    if (!categoryId) return dir;
    const { rows } = await this.db.query('SELECT name FROM jz_kb_categories WHERE id = $1', [categoryId]);
    return rows[0]?.name || dir;
  }

  // ── 内部工具执行 ────────────────────────────────────────────────────────

  /**
   * 执行内部知识库工具（替代原 MCP callTool）。
   * internalOpts 仅供本文件内部调用（如 compile_wiki 传入来源路径），不接受外部入参。
   */
  async callInternalTool(
    name: string,
    args: Record<string, any>,
    callCtx?: KnowledgeCallContext,
    internalOpts?: { sourcePath?: string; sourcePaths?: string[] },
  ): Promise<string> {
    if (name === 'ping') return 'pong';

    // 防绕过：外部参数里的 __sourcePath 一律丢弃（来源路径只能由内部代码经 internalOpts 注入）
    if (args && typeof args === 'object' && Object.prototype.hasOwnProperty.call(args, '__sourcePath')) {
      const { __sourcePath: _dropped, ...rest } = args;
      args = rest;
    }
    const sourcePath = internalOpts?.sourcePaths ?? internalOpts?.sourcePath;

    const resolved = await this.resolveVault(args?.knowledge_base, callCtx);
    if (!resolved) {
      return `Knowledge base '${args?.knowledge_base || ENTERPRISE_SPACE_SLUG}' not found.`;
    }
    const { space, fs, scopes, writable, userId, isAdmin } = resolved;
    const ctx = this.handlerCtx();

    try {
      let result: string | ContentBlock[];
      switch (name) {
        case 'search': {
          const handler = new SearchHandler(ctx, fs, space, scopes);
          const mode = args.mode || 'list';
          if (mode === 'list') {
            result = await handler.listDocuments(args.path || '*', args.tags ?? null);
          } else if (mode === 'search') {
            if (!args.query) result = 'search mode requires a query.';
            else result = await handler.searchChunks(args.query, args.path || '*', args.tags ?? null, Math.min(args.limit || 10, MAX_SEARCH));
          } else if (mode === 'references') {
            result = await handler.queryReferences(args.path || '*', args.query || '');
          } else if (mode === 'digest') {
            result = await handler.generateDigest();
          } else {
            result = `Unknown mode: ${mode}`;
          }
          break;
        }
        case 'read': {
          const handler = new ReadHandler(ctx, fs, space);
          result = await handler.read(args.path, args.pages || '', args.sections ?? null, args.include_images || false);
          break;
        }
        case 'write': {
          if (!writable) return 'Error: 该空间为只读（无写权限）。';
          if (!this.isCategoryExemptSpace(space)
            && !(await this.checkPathWritable(args.path, userId, isAdmin, 'write', sourcePath))) {
            return 'Error: 无权修改该分类下的内容。';
          }
          const handler = new WriteHandler(ctx, fs, space);
          if (args.command === 'create') {
            result = await handler.create(args.path || '/', args.title || '', args.content || '', args.tags ?? [], args.date_str || '', args.overwrite || false);
          } else if (args.command === 'str_replace') {
            result = await handler.edit(args.path, args.old_text || '', args.new_text || '', args.tags ?? null);
          } else if (args.command === 'append') {
            result = await handler.append(args.path, args.content || '', args.tags ?? null);
          } else {
            result = `Unknown command: ${args.command}`;
          }
          if (args.path?.startsWith('/wiki/')) this.invalidateKnowledgeLayerCache();
          break;
        }
        case 'delete': {
          if (!writable) return 'Error: 该空间为只读（无写权限）。';
          if (!this.isCategoryExemptSpace(space)
            && !(await this.checkPathWritable(args.path, userId, isAdmin, 'delete'))) {
            return 'Error: 无权删除该分类下的内容。';
          }
          const handler = new DeleteHandler(fs, space);
          result = await handler.delete(args.path);
          if (args.path?.startsWith('/wiki/')) this.invalidateKnowledgeLayerCache();
          break;
        }
        case 'query': {
          const handler = new QueryHandler(ctx, fs, space, scopes);
          const effectiveLimit = Math.min(args.limit || 5, 10);
          if (args.tags && args.tags.length > 0 && !args.query) {
            result = await handler.retrieveByTags(args.tags, args.scope || 'wiki', effectiveLimit);
          } else if (!args.query) {
            result = 'Please provide a `query` or `tags` to search.';
          } else {
            result = await handler.retrieve(args.query, args.scope || 'wiki', effectiveLimit, args.include_references || false);
          }
          break;
        }
        default:
          return `Unknown tool: ${name}`;
      }

      if (typeof result === 'string') return result;
      // ContentBlock[]（含图片）→ 文本化（图片以占位说明返回，原 MCP 图像块在内部调用场景无消费者）
      return result
        .map((b) => (b.type === 'text' ? b.text : `[image: ${(b as any).mimeType}]`))
        .join('\n\n');
    } catch (err: any) {
      this.logger.error(`Knowledge tool ${name} failed: ${err.message}`);
      return `企业心智查询失败: ${err.message}`;
    }
  }

  // ── CoWorker / 外部代理接口（对齐原 McpToolsService 公共方法）────────────

  /** list available knowledge tools (for CoWorker proxy) */
  async getAvailableTools(): Promise<Array<{ name: string; description: string; inputSchema?: any }>> {
    return TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  /** call a knowledge tool by name (for CoWorker proxy) */
  async callTool(
    name: string,
    args: Record<string, any>,
    scopes?: string[] | 'ADMIN_ALL',
  ): Promise<{ content: string }> {
    const text = await this.callInternalTool(name, args, { scopes });
    return { content: text };
  }

  /**
   * Returns raw knowledge tools (search/read/write/delete/query) for the wiki_compiler agent.
   * 对齐原 getRawMcpTools（guide 已移除）。
   * callCtx 携带调用身份（T2/P3：APP agent 注入 appId → 自有 APP 空间可写）。
   */
  async getRawMcpTools(callCtx?: KnowledgeCallContext): Promise<McpTool[]> {
    return TOOL_DEFS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: async (_id: string, params: any) => {
        const text = await this.callInternalTool(tool.name, params, callCtx);
        return { content: [{ type: 'text', text }] };
      },
    }));
  }

  // ── 智能体知识工具（search_knowledge 等，移植自原 getKnowledgeTools）──────

  async getKnowledgeTools(): Promise<McpTool[]> {
    return [
      {
        name: 'search_knowledge',
        description: '搜索企业心智，根据问题检索相关知识。返回带来源引用的结构化上下文。用于回答用户关于公司产品、制度、流程等问题。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索查询' },
            tags: { type: 'string', description: '按标签过滤，多个用逗号分隔（如 "产品,规格"）' },
            scope: { type: 'string', enum: ['all', 'wiki', 'sources'], description: '搜索范围: all=全部, wiki=百科, sources=来源文档' },
            limit: { type: 'number', description: '最多返回条数（默认5）' },
          },
          required: ['query'],
        },
        execute: async (
          _id: string,
          params: { query: string; tags?: string; scope?: string; limit?: number },
          ctx?: KnowledgeCallContext,
        ) => {
          this.logger.debug(`Knowledge search: ${params.query} (tags: ${params.tags || '-'}, scope: ${params.scope || 'all'}, user: ${ctx?.userEmail || '-'})`);

          const searchText = await this.callInternalTool('search', {
            knowledge_base: ENTERPRISE_SPACE_SLUG,
            mode: 'search',
            query: params.query,
            path: params.scope === 'wiki' ? '/wiki/**' : params.scope === 'sources' ? '/**' : undefined,
            tags: params.tags ? params.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
            limit: params.limit || 8,
          }, { userId: ctx?.userId, userEmail: ctx?.userEmail, scopes: ctx?.scopes });

          const noResultPatterns = ['No results', 'No matches', '没有找到', 'No documents', 'not found', '0 result'];
          const isError = noResultPatterns.some((p) => searchText.includes(p));
          const hasSubstantiveContent = searchText.trim().length > 100 && /[a-zA-Z\u4e00-\u9fa5]{10,}/.test(searchText);
          const hasResults = !isError && hasSubstantiveContent;

          this.emitKbEvent('kb_search', {
            query: params.query, tags: params.tags || null,
            scope: params.scope || 'all', hit: hasResults,
            resultLength: searchText.trim().length,
          });

          if (!hasResults) {
            return { content: [{ type: 'text', text: `未找到与"${params.query}"相关的知识。建议尝试不同的关键词，或联系管理员补充相关资料。` }] };
          }

          const MAX_CONTEXT_CHARS = 16000;
          let assembled = `## 企业心智检索结果\n\n**查询**: ${params.query}${params.tags ? `  **标签**: ${params.tags}` : ''}\n\n`;

          const sections = searchText.split(/(?=^###?\s)/m).filter((s) => s.trim());
          const seen = new Set<string>();
          let budgetRemaining = MAX_CONTEXT_CHARS;

          for (const section of sections) {
            const sourceMatch = section.match(/(?:来源|Source|File):\s*(.+?)(?:\n|$)/i) || section.match(/\*\*(.+?)\*\*/);
            const sourceKey = sourceMatch ? sourceMatch[1].trim() : section.substring(0, 80);

            if (seen.has(sourceKey)) continue;
            seen.add(sourceKey);

            if (section.length > budgetRemaining) {
              if (budgetRemaining > 200) {
                assembled += section.substring(0, budgetRemaining) + '\n\n...(内容已截断)\n';
              }
              break;
            }
            assembled += section + '\n\n';
            budgetRemaining -= section.length;
          }

          return { content: [{ type: 'text', text: assembled.trim() }] };
        },
      },
      {
        name: 'list_knowledge_tags',
        description: '列出企业心智中已有的标签分类，帮助了解知识内容结构。',
        parameters: { type: 'object', properties: {} },
        execute: async (_id: string, _params: any) => {
          const text = await this.callInternalTool('search', {
            knowledge_base: ENTERPRISE_SPACE_SLUG,
            mode: 'list',
            path: '**',
          });
          const tagSet = new Set<string>();
          const tagMatches = text.matchAll(/tags?:\s*\[([^\]]*)\]/gi);
          for (const m of tagMatches) {
            m[1].split(',').map((t) => t.trim().replace(/['"]/g, '')).filter(Boolean).forEach((t) => tagSet.add(t));
          }
          const tags = [...tagSet].sort();
          const result = tags.length > 0
            ? `企业心智标签 (${tags.length}):\n${tags.map((t) => `- ${t}`).join('\n')}`
            : '企业心智尚未设置标签。建议在文档 frontmatter 中添加 tags 字段。';
          return { content: [{ type: 'text', text: result }] };
        },
      },
      {
        name: 'compile_wiki',
        description: '将企业心智中的来源文档编译为企业百科（Wiki）。自动读取来源、生成并写入 Wiki 页面。当用户要求"生成百科"、"编译心智"、"整理资料"时调用。',
        parameters: {
          type: 'object',
          properties: {
            focus: { type: 'string', description: '可选：只处理指定文件名的文档' },
          },
        },
        execute: async (_id: string, params: { focus?: string }, ctx?: KnowledgeCallContext) => {
          this.logger.log('compile_wiki: starting');

          // 以调用者身份解析（读按分类 ACL 过滤、写按调用者角色判定）；不再硬编码 ADMIN_ALL
          const callCtx = { userId: ctx?.userId, userEmail: ctx?.userEmail, scopes: ctx?.scopes };
          const resolved = await this.resolveVault(ENTERPRISE_SPACE_SLUG, callCtx);
          if (!resolved) {
            return { content: [{ type: 'text', text: '企业心智未初始化。' }] };
          }
          let sources = (await resolved.fs.listDocuments(null)).filter(
            (d: any) => !d.path?.startsWith('/wiki/'),
          );
          if (params.focus) sources = sources.filter((d: any) => d.filename.includes(params.focus));

          if (sources.length === 0) {
            return { content: [{ type: 'text', text: '没有可处理的来源文档。请先上传文档到企业心智。' }] };
          }

          // 编译前按来源目录过滤：只编译调用者可编辑的分类；其余跳过并提示（管理员不筛）
          const skippedLabels: string[] = [];
          if (!resolved.isAdmin) {
            const allowedDirs = new Set<string>();
            const skipped = new Set<string>();
            for (const dir of this.distinctSourceDirs(sources)) {
              if (await this.checkPathWritable(dir, resolved.userId, resolved.isAdmin, 'write')) {
                allowedDirs.add(dir);
              } else {
                const label = await this.categoryLabelForDir(dir);
                if (!skipped.has(label)) {
                  skipped.add(label);
                  skippedLabels.push(label);
                }
              }
            }
            if (allowedDirs.size === 0) {
              return { content: [{ type: 'text', text: '无权编译任何来源（当前账号在这些分类下没有编辑权限）。' }] };
            }
            sources = sources.filter((d: any) =>
              allowedDirs.has(String(d.path || '').replace(/\\/g, '/')),
            );
          }

          // 编译写入 /wiki/_drafts/（本身不挂分类），按来源 raw 目录的分类判权
          const sourcePaths = this.distinctSourceDirs(sources);

          const summaries: string[] = [];
          for (const doc of sources.slice(0, 15)) {
            try {
              const text = await this.callInternalTool('read', {
                knowledge_base: ENTERPRISE_SPACE_SLUG,
                path: doc.filename,
                pages: '1-3',
              }, callCtx);
              summaries.push(`- **${doc.title || doc.filename}** (${doc.page_count || '?'}p): ${text.substring(0, 200)}`);
            } catch {
              summaries.push(`- **${doc.title || doc.filename}**: [读取失败]`);
            }
          }

          const today = new Date().toISOString().split('T')[0];
          const results: string[] = [];

          try {
            const overviewContent = [
              '---',
              'title: 企业心智总览',
              `description: ${sources.length} 篇来源文档的知识汇总`,
              `date: ${today}`,
              'tags:',
              '  - overview',
              '---',
              '',
              `本企业心智包含 ${sources.length} 篇来源文档。`,
              '',
              '## 来源文档',
              '',
              '| 文件名 | 类型 | 页数 |',
              '|--------|------|------|',
              ...sources.map((d: any) => `| ${d.title || d.filename} | ${d.file_type} | ${d.page_count || '-'} |`),
              '',
              '## 关键发现',
              '',
              ...summaries,
            ].join('\n');

            await this.callInternalTool('write', {
              knowledge_base: ENTERPRISE_SPACE_SLUG, command: 'create',
              path: '/wiki/_drafts/', title: 'overview.md',
              content: overviewContent, tags: ['overview'], overwrite: true,
            }, callCtx, { sourcePaths });
            results.push('✅ /wiki/overview.md');
            this.logger.log('compile_wiki: wrote overview.md');
          } catch (e: any) {
            results.push(`❌ overview.md: ${e.message}`);
          }

          try {
            const sourceList = sources.map((d: any) => `  - ${d.filename}`).join('\n');
            const logContent = [
              '---',
              'title: 编译日志',
              'description: 企业心智编译记录',
              `date: ${today}`,
              'tags:',
              '  - log',
              '---',
              '',
              `## [${today}] ingest`,
              '',
              `- 来源文档: ${sources.length} 篇`,
              sourceList,
              '- 创建了 overview.md 总览页',
            ].join('\n');

            await this.callInternalTool('write', {
              knowledge_base: ENTERPRISE_SPACE_SLUG, command: 'create',
              path: '/wiki/_drafts/', title: 'log.md',
              content: logContent, tags: ['log'], overwrite: true,
            }, callCtx, { sourcePaths });
            results.push('✅ /wiki/log.md');
            this.logger.log('compile_wiki: wrote log.md');
          } catch (e: any) {
            results.push(`❌ log.md: ${e.message}`);
          }

          return {
            content: [{ type: 'text', text: [
              `## 百科编译完成`,
              '',
              `已处理 ${sources.length} 篇来源文档:`,
              ...results,
              ...(skippedLabels.length > 0
                ? ['', `已跳过 ${skippedLabels.length} 个无权编辑的分类：${skippedLabels.join('、')}`]
                : []),
              '',
              '基础页面已生成到 /wiki/_drafts/ 目录，待管理员审核后发布。',
              '你可以继续让我为企业心智生成更多概念页和实体页。',
            ].join('\n') }],
            details: { __action: true, actionType: 'kb_compiling', actionData: { sourceCount: sources.length } },
          };
        },
      },
      {
        name: 'suggest_knowledge',
        description: '建议将一条新知识添加到企业心智（需管理员审核）。当发现有价值的新知识时调用。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '知识内容' },
            type: { type: 'string', enum: ['character', 'rule', 'fact'], description: '知识类型' },
            category: { type: 'string', description: '知识分类' },
          },
          required: ['content', 'type'],
        },
        execute: async (_id: string, params: any, ctx?: KnowledgeCallContext) => {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const pagePath = `/wiki/pending/${params.category || params.type}/${timestamp}.md`;
          const pageContent = `---\ntags: [${params.type}, pending]\ncategory: ${params.category || '未分类'}\n---\n\n${params.content}`;
          const text = await this.callInternalTool('write', {
            knowledge_base: ENTERPRISE_SPACE_SLUG,
            command: 'create',
            path: pagePath,
            title: `${timestamp}.md`,
            content: pageContent,
            tags: [params.type, 'pending'],
            overwrite: true,
          }, { userId: ctx?.userId, userEmail: ctx?.userEmail, scopes: ctx?.scopes });
          return { content: [{ type: 'text', text: text || '已提交知识建议，等待审核。' }] };
        },
      },
    ];
  }

  // ── Enterprise Mind: three-layer knowledge retrieval ──────────────────

  /** Fetch a compact knowledge digest for system prompt injection. */
  async fetchKnowledgeDigest(): Promise<string | null> {
    const cacheKey = `digest:${ENTERPRISE_SPACE_SLUG}`;
    const cached = this.getCachedKnowledgeLayer(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const text = await this.callInternalTool('search', {
        knowledge_base: ENTERPRISE_SPACE_SLUG,
        mode: 'digest',
      }, { scopes: 'ADMIN_ALL' });

      if (!text || text.includes('not found') || text.includes('当前为空')) {
        this.setCachedKnowledgeLayer(cacheKey, null);
        return null;
      }
      const result = text.trim() || null;
      this.setCachedKnowledgeLayer(cacheKey, result);
      return result;
    } catch (err: any) {
      this.logger.debug(`Knowledge digest fetch failed: ${err.message}`);
      return null;
    }
  }

  /** Fetch character layer content from KB (_character/ directory). */
  async fetchCharacterLayer(): Promise<string | null> {
    return this.fetchLayer('character', '/wiki/_character/**');
  }

  /** Fetch rules layer content from KB (_rules/ directory). */
  async fetchRulesLayer(): Promise<string | null> {
    return this.fetchLayer('rules', '/wiki/_rules/**');
  }

  private async fetchLayer(key: string, path: string): Promise<string | null> {
    const cacheKey = `${key}:${ENTERPRISE_SPACE_SLUG}`;
    const cached = this.getCachedKnowledgeLayer(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const text = await this.callInternalTool('read', {
        knowledge_base: ENTERPRISE_SPACE_SLUG,
        path,
      }, { scopes: 'ADMIN_ALL' });

      if (!text || text.includes('No documents found') || text.includes('not found') || text.includes('No documents matching')) {
        this.setCachedKnowledgeLayer(cacheKey, null);
        return null;
      }
      const result = text.trim() || null;
      this.setCachedKnowledgeLayer(cacheKey, result);
      return result;
    } catch (err: any) {
      this.logger.debug(`${key} layer fetch failed: ${err.message}`);
      return null;
    }
  }
}
