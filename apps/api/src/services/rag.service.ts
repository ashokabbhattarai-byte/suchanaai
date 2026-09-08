import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

export interface RagQueryResult {
  answer: string;
  sources: Array<{
    doc_id: string;
    chunk_index: number;
    content: string;
    score: number;
    title?: string;
  }>;
  model_used: string | null;
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly aiServiceUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.aiServiceUrl =
      this.config.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
  }

  async query(
    question: string,
    documentId?: string,
    topK?: number,
    userId?: string,
  ): Promise<RagQueryResult> {
    try {
      // Enforce ownership before hitting AI service to avoid leaking private doc existence via AI behavior
      if (documentId) {
        const doc = await this.prisma.document.findUnique({
          where: { id: documentId },
          select: { isSystem: true, uploadedBy: true },
        });
        if (doc && !doc.isSystem && doc.uploadedBy !== userId) {
          return {
            answer: 'This document is not available for querying.',
            sources: [],
            model_used: 'none',
          };
        }
      }
      // Determine which doc_ids this user is allowed to query
      const allowedDocIds = await this.getAllowedDocIds(userId, documentId);

      const payload: Record<string, any> = { question };
      if (documentId) {
        payload.doc_id = documentId;
      } else if (allowedDocIds) {
        payload.doc_ids = allowedDocIds;
      }
      if (topK) payload.top_k = topK;

      const response = await firstValueFrom(
        this.httpService.post(`${this.aiServiceUrl}/query`, payload, {
          // Ollama 1.5b on CPU: 5-15s generation plus fallback retries; 60s cut slow answers mid-stream and showed "(canceled)" after the frontend's 20s abort. 120s matches frontend LONG_TIMEOUT and stays below AI 180s / nginx 300s.
          timeout: 120000,
        }),
      );

      return {
        answer: response.data.answer ?? '',
        sources: response.data.sources ?? [],
        model_used: response.data.model_used ?? 'unknown',
      };
    } catch (err: any) {
      // axios reduces an upstream failure to "Request failed with status code
      // 500". The AI service puts the real cause in the body, and without it
      // there is no way to tell an embedding-model failure from a Qdrant
      // outage from a bad query.
      const upstream = err.response?.data?.error;
      const status = err.response?.status;
      this.logger.error(
        `RAG query failed${status ? ` (AI service ${status})` : ''}: ${upstream ?? err.message}`,
      );

      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || upstream) {
        return {
          answer:
            'The AI service could not answer right now. Please try again in a moment.',
          sources: [],
          model_used: 'none',
        };
      }

      throw err;
    }
  }

  /**
   * Get the list of document IDs the user is allowed to query.
   * - Anonymous users: only system docs
   * - Logged-in users: system docs + their own docs
   * - If a specific documentId is provided, the caller must have verified
   *   ownership; this method now also enforces it as defense-in-depth.
   */
  private async getAllowedDocIds(
    userId?: string,
    specificDocId?: string,
  ): Promise<string[] | null> {
    if (specificDocId) {
      // Defense-in-depth: even when a single doc is targeted, verify the
      // caller is allowed to read it. Prevents ID enumeration of private docs.
      const doc = await this.prisma.document.findUnique({
        where: { id: specificDocId },
        select: { isSystem: true, uploadedBy: true },
      });
      if (!doc) throw new Error('Document not found');
      const allowed = doc.isSystem || (userId && doc.uploadedBy === userId);
      if (!allowed) throw new Error('Access denied to this document');
      return null; // Single doc query, no filtering needed
    }

    const where = userId
      ? { OR: [{ isSystem: true }, { uploadedBy: userId }] }
      : { isSystem: true };

    const docs = await this.prisma.document.findMany({
      where: { ...where, status: 'INDEXED' },
      select: { id: true },
    });

    return docs.map((d) => d.id);
  }
}
