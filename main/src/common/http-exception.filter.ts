import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    // Only handle HTTP contexts
    if (host.getType() !== 'http') return;

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string;

    let code: string | undefined;
    let details: unknown;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      message = typeof resp === 'string' ? resp : (resp as any).message || exception.message;
      if (Array.isArray(message)) message = message.join('; ');
      // 机器可读的错误码（如 APP_LICENSE_EXPIRED）：异常响应对象带字符串 code 时原样透出
      if (resp && typeof resp === 'object' && typeof (resp as any).code === 'string') code = (resp as any).code;
      // 结构化的错误明细（如应用 invoke 返回的逐项校验问题、冲突的原因）：异常响应对象带 details 时原样透出（企业套件 55 可视编辑）
      if (resp && typeof resp === 'object' && (resp as any).details !== undefined) details = (resp as any).details;
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = '服务器内部错误';
      this.logger.error(`Unhandled exception on ${request.method} ${request.url}`, (exception as any)?.stack);
    }

    response.status(status).json({
      statusCode: status,
      ...(code ? { code } : {}),
      message,
      ...(details !== undefined ? { details } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
