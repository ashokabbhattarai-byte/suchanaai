import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ScrapePaginationType } from '@prisma/client';

export class CreateScrapeSourceDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsUrl({ require_tld: false })
  baseUrl: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  noticeListUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  newsListUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  pressReleaseListUrl?: string;

  @IsOptional()
  @IsEnum(ScrapePaginationType)
  paginationType?: ScrapePaginationType;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  paginationParam?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  startPage?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxPages?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86400)
  pollIntervalSeconds?: number;

  @IsOptional()
  @IsUrl({ require_tld: false })
  sitemapUrl?: string | null;
}

export class UpdateScrapeSourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  noticeListUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  newsListUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  pressReleaseListUrl?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsEnum(ScrapePaginationType)
  paginationType?: ScrapePaginationType;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  paginationParam?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  startPage?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxPages?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86400)
  pollIntervalSeconds?: number;

  @IsOptional()
  @IsUrl({ require_tld: false })
  sitemapUrl?: string | null;
}

export class QuickScrapeDto {
  @IsUrl({ require_tld: false })
  url: string;
}

export class DiscoverRoutesDto {
  @IsUrl({ require_tld: false })
  baseUrl: string;
}
