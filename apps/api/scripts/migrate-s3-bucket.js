// One-off migration: copy S3 objects from the old account's bucket to the new
// one, then verify every storage key the database references actually resolves.
//
// The DB needs no rewrite — Document.storageKey and Attachment.storageKey hold
// bucket-relative keys ("documents/<id>.pdf", "attachments/<id>.pdf") and the
// bucket comes from S3_BUCKET_NAME, so switching buckets is config plus a copy.
//
// Usage:
//   node scripts/migrate-s3-bucket.js              # dry run — copies nothing
//   node scripts/migrate-s3-bucket.js --apply      # perform the copy
//   node scripts/migrate-s3-bucket.js --verify-only  # skip copy, just audit DB keys
//
// Env (source bucket, old account):
//   OLD_S3_BUCKET_NAME, OLD_AWS_ACCESS_KEY_ID, OLD_AWS_SECRET_ACCESS_KEY, OLD_AWS_REGION
// Env (destination, new account) — reuses the app's own config:
//   S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
const { PrismaClient } = require('@prisma/client')
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3')

const prisma = new PrismaClient()
const apply = process.argv.includes('--apply')
const verifyOnly = process.argv.includes('--verify-only')

const DEST_BUCKET = process.env.S3_BUCKET_NAME
const SRC_BUCKET = process.env.OLD_S3_BUCKET_NAME

function client(region, accessKeyId, secretAccessKey) {
  return new S3Client({
    region: region || 'us-east-1',
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  })
}

const dest = client(
  process.env.AWS_REGION,
  process.env.AWS_ACCESS_KEY_ID,
  process.env.AWS_SECRET_ACCESS_KEY,
)
const src = client(
  process.env.OLD_AWS_REGION || process.env.AWS_REGION,
  process.env.OLD_AWS_ACCESS_KEY_ID,
  process.env.OLD_AWS_SECRET_ACCESS_KEY,
)

async function listAll(c, bucket) {
  const keys = new Map()
  let token
  do {
    const page = await c.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    )
    for (const o of page.Contents ?? []) keys.set(o.Key, o.Size)
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function exists(c, bucket, key) {
  try {
    await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch {
    return false
  }
}

// Buffers the object rather than piping the stream straight through: PutObject
// needs a known ContentLength, and a piped stream of unknown length forces a
// chunked upload that S3 rejects for this path.
async function copyObject(key) {
  const got = await src.send(new GetObjectCommand({ Bucket: SRC_BUCKET, Key: key }))
  const body = Buffer.concat(await got.Body.toArray())
  await dest.send(
    new PutObjectCommand({
      Bucket: DEST_BUCKET,
      Key: key,
      Body: body,
      ContentType: got.ContentType,
    }),
  )
  return body.length
}

async function dbKeys() {
  const [docs, atts] = await Promise.all([
    prisma.document.findMany({
      where: { storageKey: { not: '' } },
      select: { id: true, storageKey: true, filename: true },
    }),
    prisma.attachment.findMany({
      where: { storageKey: { not: null } },
      select: { id: true, storageKey: true, itemId: true },
    }),
  ])
  return [
    ...docs.map((d) => ({ kind: 'document', id: d.id, key: d.storageKey, label: d.filename })),
    ...atts.map((a) => ({ kind: 'attachment', id: a.id, key: a.storageKey, label: a.itemId })),
  ]
}

async function main() {
  if (!DEST_BUCKET) throw new Error('S3_BUCKET_NAME is not set')
  console.log(`destination bucket : ${DEST_BUCKET}`)
  console.log(`source bucket      : ${SRC_BUCKET || '(not set — copy step skipped)'}`)
  console.log(`mode               : ${verifyOnly ? 'verify-only' : apply ? 'APPLY' : 'dry run'}\n`)

  // ── Step 1: copy old → new ────────────────────────────────────────────
  if (!verifyOnly && SRC_BUCKET) {
    const [srcKeys, destKeys] = await Promise.all([
      listAll(src, SRC_BUCKET),
      listAll(dest, DEST_BUCKET),
    ])
    const missing = [...srcKeys.keys()].filter((k) => !destKeys.has(k))

    console.log(`objects in source      : ${srcKeys.size}`)
    console.log(`objects in destination : ${destKeys.size}`)
    console.log(`missing in destination : ${missing.length}`)

    if (missing.length && !apply) {
      console.log('\nwould copy (first 20):')
      missing.slice(0, 20).forEach((k) => console.log(`  ${k}`))
      if (missing.length > 20) console.log(`  … and ${missing.length - 20} more`)
    }

    if (missing.length && apply) {
      let copied = 0
      let failed = 0
      for (const key of missing) {
        try {
          const bytes = await copyObject(key)
          copied++
          console.log(`  copied ${key} (${bytes} bytes)`)
        } catch (err) {
          failed++
          console.error(`  FAILED ${key}: ${err.message}`)
        }
      }
      console.log(`\ncopied ${copied}, failed ${failed}`)
    }
    console.log('')
  }

  // ── Step 2: audit that every DB-referenced key resolves ───────────────
  const refs = await dbKeys()
  console.log(`storage keys referenced by the database: ${refs.length}`)

  const destKeys = await listAll(dest, DEST_BUCKET)
  const orphans = refs.filter((r) => !destKeys.has(r.key))

  if (orphans.length === 0) {
    console.log('every referenced key is present in the destination bucket ✓')
  } else {
    console.log(`\nMISSING from ${DEST_BUCKET}: ${orphans.length}`)
    for (const o of orphans.slice(0, 40)) {
      console.log(`  [${o.kind}] ${o.key}  (${o.label})`)
    }
    if (orphans.length > 40) console.log(`  … and ${orphans.length - 40} more`)
    console.log(
      '\nThese rows point at objects that exist in neither bucket. Downloads for\n' +
      'them will 404 — either re-scrape the attachment or clear the storage key.',
    )
  }

  // Objects in the bucket that nothing references — safe to know about, not deleted here.
  const referenced = new Set(refs.map((r) => r.key))
  const unreferenced = [...destKeys.keys()].filter((k) => !referenced.has(k))
  if (unreferenced.length) {
    console.log(`\nunreferenced objects in destination: ${unreferenced.length} (not deleted)`)
  }

  if (!apply && !verifyOnly) {
    console.log('\nDry run — nothing was copied. Re-run with --apply to perform the copy.')
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
