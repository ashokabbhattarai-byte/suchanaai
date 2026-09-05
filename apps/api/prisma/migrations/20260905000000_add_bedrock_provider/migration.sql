-- AlterEnum
ALTER TYPE "AiProviderKind" ADD VALUE 'BEDROCK';

-- AlterTable
ALTER TABLE "ai_providers" ADD COLUMN "region" TEXT;
