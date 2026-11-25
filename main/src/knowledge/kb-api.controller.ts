import {
  Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, Req, Res,
  Headers, ForbiddenException, UnauthorizedException, NotFoundException,
  BadRequestException, UseInterceptors, UploadedFile, Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import * as express from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DbService } from '../db/db.service';
import { UserService } from '../user/user.service';
import { SpacesService, KbSpace, ENTERPRISE_SPACE_SLUG } from './spaces.service';
import { KbAccessService } from './kb-access.service';
import { ProcessorService } from './processor/processor.service';
import { DocRepository, ChunkRepository } from './shared/repository';
import { chunkText } from './shared/chunker';
import { scopeFilterSql } from './shared/scopes';
import { parseFrontmatter, titleFromFilename, extractTags } from './shared/frontmatter';

const UPDATABLE_FIELDS = new Set([
  'filename', 'path', 'title', 'tags', 'date', 'metadata',
  'relative_path', 'source_kind', 'status', 'sensitivity',
]);

const SIMPLE_TEXT_TYPES = new Set(['md', 'txt', 'csv', 'svg', 'json', 'xml']);
const NEEDS_PROCESSING = new Set([
  'pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
]);

/** 上传白名单（扩展名，小写、不含点） */
const ALLOWED_UPLOAD_EXTS = new Set([
  'md', 'txt', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'html', 'htm', 'json', 'xml',
]);

/** 上传体积上限 20MB */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
};

interface Caller {
  userId: string;
  permissions: string[];
  token: string;
  isAdmin: boolean;
}

/**
 * KbApiController — 知识库 HTTP API（替代原 bridge/knowledge KbController 的 kbs 代理）。
 * 保持 /api/kb/v1/* 路径与响应结构兼容；鉴权改为主台 JWT + 空间可见性。
 */
@SkipThrottle()
@Controller('api/kb')
export class KbApiController {
  private readonly logger = new Logger(KbApiController.name);

  constructor(
    private readonly db: DbService,
    private readonly userService: UserService,
    private readonly spaces: SpacesService,
    private readonly kbAccess: KbAccessService,
    private readonly processor: ProcessorService,
  ) {}

  // ── 鉴权与空间解析 ───────────────────────────────────────────────────────

  private async resolveCaller(auth: string): Promise<Caller | null> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;
    const user = this.userService.verifyToken(token);
    if (!user) return null;
    const isAdmin = await this.kbAccess.isAdmin(user.id);
    return { userId: user.id, permissions: user.role.permissions || [], token, isAdmin };
  }

  /**
   * 已废弃：知识库已独立为 APP，平台不再以 kb:read / kb:write 作为门禁。
   * 访问控制由「应用授权」（能否打开面板）+「分类授权」（能看/改哪些分类）两层决定。
   * 保留空实现以防遗漏调用点，全部调用已移除。
   */
  private requirePermission(_caller: Caller, _perm: 'kb:read' | 'kb:write') { /* no-op */ }

  /** 解析空间并校验可读；不可见 → 404（不暴露存在性） */
  private async resolveReadableSpace(kbId: string, caller: Caller): Promise<KbSpace> {
    const space = await this.spaces.resolve(kbId);
    if (!space || !this.spaces.canRead(space, caller.userId, caller.isAdmin)) {
      throw new NotFoundException({ detail: 'Knowledge base not found' });
    }
    return space;
  }

  private requireWritable(space: KbSpace, caller: Caller) {
    if (!this.spaces.canWrite(space, caller.userId, caller.isAdmin)) {
      throw new ForbiddenException({ detail: '该空间为只读' });
    }
  }

  /**
   * 分类级写校验。
   * - 管理员 → 放行
   * - 未分类（null）→ 仅管理员可写（fail-closed）
   * - admin → 放行
   * - editor → 仅允许「改内容 / 改名 / 移动」(mutate)，拒绝新增 / 上传 / 删除
   * - viewer / 无授权 → 全部拒绝
   */
  private async requireCategoryWritable(
    categoryId: string | null,
    caller: Caller,
    action: 'mutate' | 'create' | 'delete' = 'mutate',
  ): Promise<void> {
    if (caller.isAdmin) return;
    if (!categoryId) {
      throw new ForbiddenException({ detail: '未分类文档仅管理员可写' });
    }
    const scopes = await this.kbAccess.getAccessibleScopesWithRole(caller.userId);
    if (scopes === 'ADMIN_ALL') return;
    const hit = scopes.find((s) => s.categoryId === String(categoryId));
    const allowed =
      !!hit &&
      (hit.role === 'admin' || (hit.role === 'editor' && action === 'mutate'));
    if (!allowed) {
      throw new ForbiddenException({
        detail: action === 'mutate' ? '无编辑权限' : '无新增/删除权限',
      });
    }
  }

  /**
   * 文档级写校验：空间可写 + （个人空间本人例外）+ 分类级角色校验。
   */
  private async requireDocWritable(
    doc: any,
    space: KbSpace | null,
    caller: Caller,
    action: 'mutate' | 'create' | 'delete',
  ): Promise<void> {
    if (!space) throw new NotFoundException({ detail: 'Knowledge base not found' });
    this.requireWritable(space, caller);
    // 个人空间：本人对自己空间的文档拥有完全写权限（无分类概念）
    if (space.subtype === 'personal' && doc.owner_user_id === caller.userId) return;
    await this.requireCategoryWritable(doc.category_id ?? null, caller, action);
  }

  /** 去掉 raw/ wiki/ sources/ 首段，得到与 jz_kb_categories.path 对齐的分类路径 */
  private normalizeCategoryPath(docPath: string | null | undefined): string | null {
    if (!docPath) return null;
    const segments = String(docPath).split('/').filter((s) => s.length > 0);
    if (segments.length > 0 && ['wiki', 'raw', 'sources'].includes(segments[0])) {
      segments.shift();
    }
    if (segments.length === 0) return null;
    return '/' + segments.join('/');
  }

  /** 按分类 path 最长前缀匹配出 categoryId；匹配不到返回 null */
  private async resolveCategoryIdByPath(spaceId: string, docPath: string | null | undefined): Promise<string | null> {
    const normalized = this.normalizeCategoryPath(docPath);
    if (!normalized || !spaceId) return null;
    const segments = normalized.split('/').filter((s) => s.length > 0);
    for (let i = segments.length; i > 0; i--) {
      const candidate = '/' + segments.slice(0, i).join('/');
      const { rows } = await this.db.query(
        'SELECT id FROM jz_kb_categories WHERE path = $1 AND space_id = $2',
        [candidate, spaceId],
      );
      if (rows.length > 0) return String(rows[0].id);
    }
    return null;
  }

  /** 文件名校验与净化：去掉路径分隔符与控制字符 */
  private sanitizeFilename(name: string): string {
    const cleaned = String(name || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[\\/]/g, '')
      .replace(/^\.+$/, '')
      .trim();
    return cleaned;
  }

  private async scopesFor(caller: Caller): Promise<Set<string> | null> {
    const scopes = await this.kbAccess.getAccessibleScopesForUser(caller.userId);
    if (scopes === 'ADMIN_ALL') return null;
    return new Set(scopes);
  }

  private safeResolve(root: string, relative: string): string {
    const ws = path.resolve(root);
    const resolved = path.resolve(ws, relative);
    if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
      throw new ForbiddenException({ detail: 'Path escapes workspace' });
    }
    return resolved;
  }

  private docDiskPath(space: KbSpace, doc: any): string | null {
    const relative = `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
    const ws = path.resolve(this.spaces.rootFor(space.slug));
    const resolved = path.resolve(ws, relative);
    return resolved.startsWith(ws + path.sep) ? resolved : null;
  }

  // ── 个人知识（主台端点）──────────────────────────────────────────────────

  @Post('personal-knowledge')
  async savePersonalKnowledge(
    @Body() body: { content: string; title?: string; tags?: string[] },
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();

    const space = await this.spaces.ensurePersonalSpace(caller.userId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = body.title || `知识笔记 ${timestamp.slice(0, 10)}`;
    const tags = body.tags || ['personal'];
    const filename = `${timestamp}.md`;

    const frontmatter = [
      '---',
      `title: ${title}`,
      'description: 个人知识',
      'tags:',
      ...tags.map((t) => `  - ${t}`),
      '---',
      '',
    ].join('\n');

    const result = await this.createNote(space, caller, {
      filename,
      path: '/raw/',
      content: frontmatter + body.content,
    });
    return { success: true, data: result };
  }

  // ── 空间（兼容旧 /v1/knowledge-bases）────────────────────────────────────

  @Get('v1/knowledge-bases')
  async listKnowledgeBases(@Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    return this.spaces.listVisible(caller.userId, caller.isAdmin);
  }

  @Post('v1/knowledge-bases')
  async createKnowledgeBase(@Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const list = await this.spaces.listVisible(caller.userId, caller.isAdmin);
    return list[0] || null;
  }

  @Get('v1/knowledge-bases/:kbId')
  async getKnowledgeBase(@Param('kbId') kbId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const list = await this.spaces.listVisible(caller.userId, caller.isAdmin);
    const space = await this.resolveReadableSpace(kbId, caller);
    return list.find((s: any) => s.slug === space.slug) || null;
  }

  @Patch('v1/knowledge-bases/:kbId')
  async patchKnowledgeBase(@Param('kbId') kbId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const list = await this.spaces.listVisible(caller.userId, caller.isAdmin);
    const space = await this.resolveReadableSpace(kbId, caller);
    return list.find((s: any) => s.slug === space.slug) || null;
  }

  @Delete('v1/knowledge-bases/:kbId')
  async deleteKnowledgeBase() {
    throw new ForbiddenException({ detail: 'Cannot delete space via API' });
  }

  // ── 文档读 ──────────────────────────────────────────────────────────────

  @Get('v1/knowledge-bases/:kbId/documents')
  async listDocuments(
    @Param('kbId') kbId: string,
    @Query('path') docPath: string,
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const space = await this.resolveReadableSpace(kbId, caller);
    const repo = new DocRepository(this.db);
    return repo.list({ path: docPath, spaceId: space.id, scopes: await this.scopesFor(caller), userId: caller.userId });
  }

  @Get('v1/knowledge-bases/:kbId/search')
  async searchDocuments(
    @Param('kbId') kbId: string,
    @Query('q') q: string,
    @Query('limit') limitRaw: string,
    @Query('scope') scope: string,
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const space = await this.resolveReadableSpace(kbId, caller);
    if (!q || q.length < 1) return { detail: 'q is required' };

    let limit = parseInt(limitRaw || '20', 10);
    if (Number.isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    let sql =
      'SELECT dc.content, dc.page, dc.header_breadcrumb, dc.chunk_index, ' +
      'd.filename, d.title, d.path, d.file_type, d.tags, d.category_id, d.metadata, ' +
      'similarity(dc.content, $1) AS score ' +
      'FROM jz_kb_document_chunks dc ' +
      'JOIN jz_kb_documents d ON dc.document_id = d.id ' +
      "WHERE dc.content ILIKE '%' || $1 || '%' " +
      "AND d.status = 'ready' AND d.space_id = $2 ";
    const params: any[] = [q, space.id];

    if (scope === 'wiki') sql += "AND d.source_kind = 'wiki' ";
    else if (scope === 'sources') sql += "AND d.source_kind != 'wiki' ";

    sql += "AND COALESCE(d.sensitivity, 'public') != 'restricted' ";

    const sf = scopeFilterSql(await this.scopesFor(caller), 3, 'd', caller.userId);
    sql += sf.sql;
    params.push(...sf.params);

    sql += `ORDER BY score DESC LIMIT $${sf.nextIdx}`;
    params.push(limit);

    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  @Get('v1/documents/:docId')
  async getDocument(@Param('docId') docId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const doc = await this.getReadableDoc(docId, caller);
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    return doc;
  }

  @Get('v1/documents/:docId/url')
  async getDocumentUrl(@Param('docId') docId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const doc = await this.getReadableDoc(docId, caller);
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const relative =
      doc.relative_path || `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
    const space = await this.spaces.resolve(doc.space_id);
    return { url: `/api/kb/v1/files/spaces/${space?.slug || ENTERPRISE_SPACE_SLUG}/${relative}` };
  }

  @Get('v1/documents/:docId/content')
  async getDocumentContent(@Param('docId') docId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const doc = await this.getReadableDoc(docId, caller);
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const { rows } = await this.db.query(
      'SELECT id, filename, path, content, file_type FROM jz_kb_documents WHERE id = $1',
      [docId],
    );
    return rows[0] || null;
  }

  @Get('v1/documents/:docId/extractions')
  async getExtractions() {
    throw new NotFoundException({ detail: 'Extractions not available' });
  }

  private async getReadableDoc(docId: string, caller: Caller): Promise<any | null> {
    const { rows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    const doc = rows[0];
    if (!doc) return null;
    return (await this.canReadDocRecord(doc, caller)) ? doc : null;
  }

  /**
   * 文档记录读权限（读路径与文件下载共用同一口径）：
   * 空间可读 + 管理员/所有者直接放行 + 其余按 category_id 走分类授权；
   * 未分类（category_id 为 NULL）对非管理员视为无授权。
   */
  private async canReadDocRecord(doc: any, caller: Caller): Promise<boolean> {
    const space = await this.spaces.resolve(doc.space_id);
    if (!space || !this.spaces.canRead(space, caller.userId, caller.isAdmin)) return false;
    if (caller.isAdmin) return true;
    if (doc.owner_user_id === caller.userId) return true;
    if (!doc.category_id) return false;
    const scopes = await this.kbAccess.getAccessibleScopesForUser(caller.userId);
    if (scopes === 'ADMIN_ALL') return true;
    return scopes.includes(String(doc.category_id));
  }

  // ── 文档写 ──────────────────────────────────────────────────────────────

  @Post('v1/knowledge-bases/:kbId/documents/note')
  async createNoteEndpoint(
    @Param('kbId') kbId: string,
    @Body() body: { filename?: string; path?: string; content?: string },
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const space = await this.resolveReadableSpace(kbId, caller);
    this.requireWritable(space, caller);
    // 个人空间本人不受分类授权约束；企业空间按路径解析分类并校验「新增」权限
    if (!(space.subtype === 'personal' && space.owner_user_id === caller.userId)) {
      await this.requireCategoryWritable(
        await this.resolveCategoryIdByPath(space.id, body?.path || '/'),
        caller,
        'create',
      );
    }
    return this.createNote(space, caller, body);
  }

  private async createNote(
    space: KbSpace,
    caller: Caller,
    body: { filename?: string; path?: string; content?: string },
  ) {
    const filename = body.filename;
    if (!filename) throw new NotFoundException({ detail: 'filename is required' });
    const dirPath = body.path || '/';
    const content = body.content ?? '';

    const meta = parseFrontmatter(content);
    let title = (meta.title || '').trim() || titleFromFilename(filename);
    const tags = extractTags(meta);

    const findByPath = async (fn: string) => {
      const { rows } = await this.db.query(
        "SELECT * FROM jz_kb_documents WHERE filename = $1 AND path = $2 AND space_id = $3 AND status != 'archived'",
        [fn, dirPath, space.id],
      );
      return rows[0] || null;
    };

    if (content) {
      const existing = await findByPath(filename);
      if (existing && (existing.content || '') === content) {
        return existing;
      }
    }

    let finalFilename = filename;
    const dotIdx = filename.lastIndexOf('.');
    const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
    const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';
    let counter = 1;
    while (await findByPath(finalFilename)) {
      counter += 1;
      finalFilename = `${stem} ${counter}${ext}`;
    }
    if (finalFilename !== filename) title = titleFromFilename(finalFilename);

    const relative = `${dirPath.replace(/\/$/, '')}/${finalFilename}`.replace(/^\//, '');
    const filePath = this.safeResolve(this.spaces.rootFor(space.slug), relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');

    const sourceKind = dirPath.replace(/^\//, '').startsWith('wiki') ? 'wiki' : 'source';
    const ownerId = space.subtype === 'personal' ? caller.userId : null;
    // 建档即回填分类：否则文档一创建就是「未分类」，非管理员后续编辑/删除会被判为无权限
    const categoryId = await this.resolveCategoryIdByPath(space.id, dirPath);

    const docId = crypto.randomUUID();
    await this.db.query(
      'INSERT INTO jz_kb_documents ' +
        '(id, owner_user_id, filename, title, path, relative_path, source_kind, ' +
        "file_type, status, content, tags, version, space_id, category_id) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, 'md', 'ready', $8, $9, 0, $10, $11)",
      [docId, ownerId, finalFilename, title, dirPath, relative, sourceKind, content, tags, space.id, categoryId],
    );

    if (content) {
      await new ChunkRepository(this.db).storeChunks(docId, chunkText(content));
    }

    return {
      id: docId,
      filename: finalFilename,
      path: dirPath,
      title,
      relative_path: relative,
      source_kind: sourceKind,
      status: 'ready',
    };
  }

  @Put('v1/documents/:docId/content')
  async updateContent(
    @Param('docId') docId: string,
    @Body() body: { content?: string },
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const { rows: docRows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    const doc = docRows[0];
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const space = await this.spaces.resolve(doc.space_id);
    await this.requireDocWritable(doc, space, caller, 'mutate');

    const content = body.content ?? '';
    const fp = this.docDiskPath(space!, doc);
    if (fp) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf-8');
    }
    await this.db.query('UPDATE jz_kb_documents SET content = $1, updated_at = NOW() WHERE id = $2', [
      content,
      docId,
    ]);
    if (content) {
      await new ChunkRepository(this.db).storeChunks(docId, chunkText(content));
    }
    const { rows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    return rows[0];
  }

  @Patch('v1/documents/:docId')
  async patchDocument(
    @Param('docId') docId: string,
    @Body() body: Record<string, any>,
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const { rows: docRows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    const doc = docRows[0];
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const space = await this.spaces.resolve(doc.space_id);
    await this.requireDocWritable(doc, space, caller, 'mutate');

    // 改名/移动：目标目录同样需要可写（editor 允许移动，但不得移入无授权分类）
    const targetDirs = [
      body?.path,
      body?.relative_path ? String(body.relative_path).replace(/[^/]*$/, '/') : null,
    ].filter((d) => d && d !== doc.path);
    if (!(space!.subtype === 'personal' && doc.owner_user_id === caller.userId)) {
      for (const dir of [...new Set(targetDirs)]) {
        await this.requireCategoryWritable(
          await this.resolveCategoryIdByPath(space!.id, dir),
          caller,
          'mutate',
        );
      }
    }

    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(body || {})) {
      if (v !== null && v !== undefined && UPDATABLE_FIELDS.has(k)) {
        sets.push(`${k} = $${idx++}`);
        params.push(v);
      }
    }
    if (sets.length === 0) return { detail: 'No fields to update' };
    params.push(docId);
    await this.db.query(
      `UPDATE jz_kb_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      params,
    );
    const { rows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    return rows[0];
  }

  @Delete('v1/documents/:docId')
  async deleteDocument(@Param('docId') docId: string, @Headers('authorization') auth: string, @Res() res: express.Response) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const { rows: docRows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    const doc = docRows[0];
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const space = await this.spaces.resolve(doc.space_id);
    await this.requireDocWritable(doc, space, caller, 'delete');
    const fp = this.docDiskPath(space!, doc);
    if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    await this.db.query("UPDATE jz_kb_documents SET status = 'archived' WHERE id = $1", [docId]);
    return res.status(204).send();
  }

  @Post('v1/documents/bulk-delete')
  async bulkDelete(@Body() body: { ids?: string[] }, @Headers('authorization') auth: string, @Res() res: express.Response) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const ids = body?.ids || [];
    for (const docId of ids) {
      const { rows: docRows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
      const doc = docRows[0];
      if (!doc) continue;
      const space = await this.spaces.resolve(doc.space_id);
      await this.requireDocWritable(doc, space, caller, 'delete');
      const fp = this.docDiskPath(space!, doc);
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    if (ids.length > 0) {
      await this.db.query('DELETE FROM jz_kb_documents WHERE id = ANY($1)', [ids]);
    }
    return res.status(204).send();
  }

  // ── 上传 ────────────────────────────────────────────────────────────────

  @Post('v1/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @UploadedFile() file: any,
    @Body() body: { path?: string; space?: string },
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    if (!file?.buffer || !file.originalname) {
      throw new NotFoundException({ detail: 'No filename' });
    }

    const space = await this.resolveReadableSpace(body?.space || ENTERPRISE_SPACE_SLUG, caller);
    this.requireWritable(space, caller);

    // multer/busboy 默认 defParamCharset=latin1，浏览器发来的 UTF-8 文件名会被误解码，需转回
    const filename = this.sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'));
    if (!filename) throw new BadRequestException({ detail: '非法文件名' });

    const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
    if (!ext || !ALLOWED_UPLOAD_EXTS.has(ext)) {
      throw new BadRequestException({ detail: `不支持的文件类型: ${ext || '(无扩展名)'}` });
    }

    // 路径规范化：去掉 ..，且必须落在 /raw/ 下
    const dirParam = (body?.path || '/raw/').trim() || '/raw/';
    const normalized = path.posix.normalize(`${dirParam.replace(/\/$/, '')}/${filename}`).replace(/^\/+/, '');
    if (normalized.split('/').includes('..')) {
      throw new BadRequestException({ detail: '非法路径' });
    }
    if (!('/' + normalized).startsWith('/raw/')) {
      throw new BadRequestException({ detail: '上传路径必须位于 /raw/ 下' });
    }
    const relative = normalized;

    // 分类级写校验（个人空间本人例外）；未分类上传仅管理员可写
    let categoryId: string | null = null;
    if (!(space.subtype === 'personal' && space.owner_user_id === caller.userId)) {
      categoryId = await this.resolveCategoryIdByPath(space.id, relative);
      await this.requireCategoryWritable(categoryId, caller, 'create');
    }

    const dest = this.safeResolve(this.spaces.rootFor(space.slug), relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const contentBytes: Buffer = file.buffer;
    fs.writeFileSync(dest, contentBytes);

    const title = titleFromFilename(filename);
    const dirPath = relative.includes('/')
      ? `/${relative.split('/').slice(0, -1).join('/')}/`
      : '/';
    const sourceKind = relative.startsWith('wiki/assets/')
      ? 'asset'
      : relative.startsWith('wiki/')
        ? 'wiki'
        : 'source';
    const contentHash = crypto.createHash('sha256').update(contentBytes).digest('hex');

    let textContent: string | null = null;
    if (SIMPLE_TEXT_TYPES.has(ext)) {
      textContent = contentBytes.toString('utf-8');
    }

    const stat = fs.statSync(dest);
    const mtimeNs = String(BigInt(Math.round(stat.mtimeMs)) * 1000000n);

    const docId = crypto.randomUUID();
    const { rows } = await this.db.query(
      'INSERT INTO jz_kb_documents (id, filename, title, path, relative_path, ' +
        'source_kind, file_type, file_size, status, content, content_hash, ' +
        'mtime_ns, last_indexed_at, space_id, owner_user_id, category_id) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, $15) ' +
        'ON CONFLICT (space_id, relative_path) DO UPDATE SET ' +
        'filename = EXCLUDED.filename, title = EXCLUDED.title, ' +
        'file_size = EXCLUDED.file_size, status = EXCLUDED.status, ' +
        'content = EXCLUDED.content, content_hash = EXCLUDED.content_hash, ' +
        'mtime_ns = EXCLUDED.mtime_ns, category_id = EXCLUDED.category_id, ' +
        'owner_user_id = EXCLUDED.owner_user_id, error_message = NULL, ' +
        'version = jz_kb_documents.version + 1, updated_at = NOW() ' +
        'RETURNING id',
      [
        docId, filename, title, dirPath, relative, sourceKind,
        ext || 'bin', contentBytes.length,
        textContent !== null ? 'processing' : 'pending',
        textContent, contentHash, mtimeNs,
        space.id, caller.userId, categoryId,
      ],
    );
    const finalDocId = rows[0].id;

    if (textContent !== null) {
      // 文本类：先切块，成功后再置 ready；失败写 failed + error_message
      try {
        await new ChunkRepository(this.db).storeChunks(finalDocId, chunkText(textContent));
        await this.db.query(
          "UPDATE jz_kb_documents SET status = 'ready', error_message = NULL, last_indexed_at = NOW(), updated_at = NOW() WHERE id = $1",
          [finalDocId],
        );
      } catch (e: any) {
        const msg = String(e?.message || e).slice(0, 2000);
        this.logger.error(`Chunking failed for ${finalDocId}: ${msg}`);
        await this.db.query(
          "UPDATE jz_kb_documents SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1",
          [finalDocId, msg],
        );
      }
    } else if (NEEDS_PROCESSING.has(ext)) {
      this.processor.enqueue(finalDocId);
    }

    const doc = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [finalDocId]);
    return doc.rows[0] || { id: finalDocId };
  }

  // ── 文件服务（Range + ETag + 防穿越，空间感知）──────────────────────────

  @Get('v1/files/*')
  async serveFile(@Req() req: express.Request, @Res() res: express.Response, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();

    // Express 5：从 URL 派生通配段
    const idx = req.path.indexOf('/v1/files/');
    const key = idx >= 0 ? decodeURIComponent(req.path.slice(idx + '/v1/files/'.length)) : '';
    if (!key) throw new NotFoundException({ detail: 'File not found' });

    const filePath = this.resolveFileKey(key, caller);
    if (!filePath) throw new NotFoundException({ detail: 'File not found' });

    // 分类级读校验：非管理员必须能按文档 category_id 读到该记录（与 getReadableDoc 同口径）
    if (!caller.isAdmin) {
      const doc = await this.findDocForFile(filePath, key);
      if (!doc || !(await this.canReadDocRecord(doc, caller))) {
        throw new ForbiddenException({ detail: '无权访问该文件' });
      }
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const etag = `"${crypto.createHash('sha256').update(`${filePath}:${stat.mtimeMs}:${stat.size}`).digest('hex').slice(0, 32)}"`;

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).setHeader('ETag', etag).send();
    }

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [startStr, endStr] = range.slice(6).split('-', 2);
      const start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      if (Number.isNaN(start) || start < 0 || start >= stat.size) {
        return res.status(416).send({ detail: 'Range not satisfiable' });
      }
      if (Number.isNaN(end)) end = stat.size - 1;
      end = Math.min(end, stat.size - 1);
      const length = end - start + 1;
      res.status(206);
      res.set({
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': length,
        'Accept-Ranges': 'bytes',
        ETag: etag,
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.set({
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      ETag: etag,
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  /**
   * 由文件 key + 命中磁盘路径反查文档记录（用于下载时的分类级权限校验）。
   * 只有当磁盘路径确实等于「该文档所属空间根 + relative_path」时才认定，避免跨空间同名文件误判。
   */
  private async findDocForFile(filePath: string, key: string): Promise<any | null> {
    const candidates = new Set<string>();
    if (key.startsWith('spaces/')) {
      const parts = key.split('/');
      if (parts.length > 2) candidates.add(parts.slice(2).join('/'));
    }
    candidates.add(key);

    for (const rel of candidates) {
      const { rows } = await this.db.query(
        "SELECT * FROM jz_kb_documents WHERE relative_path = $1 AND status != 'archived' ORDER BY created_at DESC",
        [rel],
      );
      for (const doc of rows) {
        const space = await this.spaces.resolve(doc.space_id);
        if (!space) continue;
        const root = path.resolve(this.spaces.rootFor(space.slug));
        if (filePath === path.resolve(root, rel)) return doc;
      }
    }
    return null;
  }

  /**
   * 文件 key 解析（按优先级）：
   * 1. spaces/{slug}/... 显式空间路径
   * 2. 各可见空间根（企业空间、本人个人空间）
   * 3. 空间内 .llmwiki/cache/ 派生缓存
   * 4. legacy 工作区根（旧文件，不迁移，逐步淘汰）
   */
  private resolveFileKey(key: string, caller: Caller): string | null {
    const kbRoot = path.resolve(this.spaces.kbRoot);
    const candidates: string[] = [];

    if (key.startsWith('spaces/')) {
      candidates.push(path.resolve(kbRoot, key));
    } else {
      for (const slug of [ENTERPRISE_SPACE_SLUG, `u-${caller.userId}`]) {
        const spaceRoot = this.spaces.rootFor(slug);
        candidates.push(path.resolve(spaceRoot, key));
        candidates.push(path.resolve(spaceRoot, '.llmwiki', 'cache', key));
      }
      // legacy 兼容（旧文件弃置原位，不再写入）
      candidates.push(path.resolve(kbRoot, key));
      candidates.push(path.resolve(kbRoot, '.llmwiki', 'cache', key));
    }

    for (const candidate of candidates) {
      if (!candidate.startsWith(kbRoot + path.sep)) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }

  // ── 用量 / me ───────────────────────────────────────────────────────────

  @Get('v1/usage')
  async getUsage(@Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const { rows } = await this.db.query(
      "SELECT count(*)::int AS doc_count, " +
        'COALESCE(SUM(page_count), 0)::bigint AS total_pages, ' +
        'COALESCE(SUM(file_size), 0)::bigint AS total_storage ' +
        "FROM jz_kb_documents WHERE status != 'failed'",
    );
    const row = rows[0] || {};
    return {
      total_pages: Number(row.total_pages || 0),
      total_storage_bytes: Number(row.total_storage || 0),
      document_count: row.doc_count || 0,
      max_pages: 999999,
      max_storage_bytes: 999999999999,
    };
  }

  @Get('v1/me')
  async getMe(@Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const user = this.userService.verifyToken(caller.token);
    return {
      id: caller.userId,
      email: (user as any)?.email || '',
      display_name: (user as any)?.displayName || (user as any)?.email || '',
      onboarded: true,
    };
  }

  @Post('v1/onboarding/complete')
  async completeOnboarding(@Res() res: express.Response) {
    return res.status(204).send();
  }
}
