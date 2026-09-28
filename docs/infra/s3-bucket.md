# The proof-of-delivery bucket

What has to be true of the S3 bucket before `FILES_ENABLED=true` is turned on.
None of this can be done from the application: it needs the AWS account that
ticket 0.10 sets up, under a **signed AWS Business Associate Addendum**. S3 is
a HIPAA-eligible service only when that addendum is in place.

Nothing here is applied automatically. Apply it, then set the `S3_*` values in
`server/.env`. Until then every file endpoint answers 503 and says so, rather
than appearing to store something.

**`create-pod-bucket.sh` in this directory does all of it**, in the order that
matters, and stops to confirm before it touches anything. Fill in the four
values at the top and run it. Read the rest of this document anyway: the script
is the typing, and what follows is why each setting is what it is. The two
things the script deliberately leaves undone are the retention period, which is
a contract decision, and anything on Render.

## What the application assumes

- **Every object is encrypted with SSE-KMS.** The encryption headers are part
  of the presigned PUT signature, so a request that omits them does not match
  and S3 rejects it. The bucket policy below makes that a rule of the bucket
  as well, so the guarantee does not rest on the application alone.
- **Nothing is ever public.** Every read is a fresh presigned GET valid for
  five minutes.
- **Keys look like** `project/date/order-<id>/kind/<uuid>.<ext>`, for example
  `uh/2026-09-12/order-418/doorstep/1f0c….jpg`. The server builds them; a
  client cannot propose one, so a patient's name cannot arrive in an object
  key by way of a helpfully named photo.

## 1. Block public access

Turn on all four settings at the bucket level. Not "mostly": a proof of
delivery is a photo of a patient's front door.

```bash
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## 2. Default encryption, and refuse anything else

Default encryption covers objects written without the headers; the policy
covers the rest by rejecting them outright.

```bash
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{
  "Rules": [{
    "ApplyServerSideEncryptionByDefault": { "SSEAlgorithm": "aws:kms", "KMSMasterKeyID": "'"$KMS_KEY_ARN"'" },
    "BucketKeyEnabled": true
  }]
}'
```

The policy has two statements: no unencrypted writes, and no plaintext
transport.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyUnencryptedObjectUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::BUCKET/*",
      "Condition": { "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" } }
    },
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

## 2b. Versioning

**Enable it, and enable it before the first object is written.** Versioning
cannot be applied retroactively to objects that already exist, and a bucket
that held proof of delivery photographs unversioned for a month has a month of
photographs that an accidental delete removes permanently.

```bash
aws s3api put-bucket-versioning --bucket <bucket> \
  --versioning-configuration Status=Enabled
```

It is the backup for the half of the system a Turso restore does not cover
(ticket 4.4). A database snapshot restores the `files` row that says a
photograph exists; it does not restore the photograph. Without versioning, a
delete is final, including the deletes this application makes itself during a
retention purge.

Two consequences to hold together:

- **The retention purge deletes objects** (ticket 4.6). With versioning on, the
  delete creates a delete marker and the object is still there as a noncurrent
  version. **The `NoncurrentVersionExpiration` rule below is therefore part of
  the disposal control, not housekeeping**: without it, purged photographs are
  still in the bucket. Thirty days is the placeholder and it belongs in the
  same retention decision as everything else.
- **MFA delete** is worth considering for a bucket holding PHI, and it makes
  automated deletion impossible, which would break the purge. Decide which is
  wanted before turning either on.

## 3. Lifecycle

Two rules. The first is housekeeping; the second is a **retention decision
that is not ours to make alone**.

```json
{
  "Rules": [
    {
      "ID": "AbandonUploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
    },
    {
      "ID": "RetainProofOfDelivery",
      "Status": "Disabled",
      "Filter": { "Prefix": "" },
      "Expiration": { "Days": 2555 }
    }
  ]
}
```

`RetainProofOfDelivery` is **deliberately disabled**, and 2555 days (seven
years) is a placeholder, not advice. The same placeholder, undecided in the
same way, is in `server/src/core/retention/policy.ts` (ticket 4.6): the
application counts what is past it and refuses to purge anything until
somebody decides. **It is one decision and it has to be made in both places,
or the bucket and the database will disagree about what still exists.** How long proof of delivery has to be kept
is a contract and records-retention question for University Health and Izy's
compliance counsel, not a default a developer should pick. Turning on a rule
that deletes evidence is the kind of thing that is noticed years later during
an audit. Decide the number first, write it into the privacy and security
program, then enable it.

A pending row in the `files` table whose upload never happened leaves no
object at all, so nothing needs expiring for those; the rule above only cleans
up interrupted multipart uploads.

## 4. CORS

The browser PUTs straight to S3, so the bucket has to allow it from the
application's origin. Only the origin the app is served from, not `*`.

```json
[
  {
    "AllowedOrigins": ["https://YOUR-APP-ORIGIN"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type", "x-amz-server-side-encryption", "x-amz-server-side-encryption-aws-kms-key-id"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

The allowed headers are exactly the ones the presigned PUT signs. A missing
one here shows up as a CORS failure in the browser rather than an S3 error,
which is a confusing way to find out.

## 5. The application's IAM user

Least privilege: this user signs URLs, it does not administer anything. It
needs no `s3:ListBucket`, because the application knows what exists from its
own `files` table rather than by listing the bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjectsInThisBucketAndNoOther",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::BUCKET/*"
    },
    {
      "Sid": "TheKeyThoseObjectsAreEncryptedWith",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "KMS_KEY_ARN"
    }
  ]
}
```

**`s3:DeleteObject` is not optional, and omitting it fails in the direction
nobody checks.** The retention purge signs a DELETE and sends it: `presignDelete`
in `core/files/storage.ts`, called from `core/retention/routes.ts`. Without this
action the sweep marks the row disposed and S3 answers 403, which leaves the
database saying a photograph is gone while the photograph is still in the
bucket. That is the disagreement section 2b warns about, arriving through a
different door, and the first time anybody notices is an audit asking to see the
disposal evidence.

With versioning on that DELETE writes a delete marker rather than removing
anything, which is why `NoncurrentVersionExpiration` above is part of the
disposal control and not housekeeping. `s3:DeleteObjectVersion` is deliberately
**not** granted: the application should be able to supersede a version, never to
destroy one, and the lifecycle rule does the rest on its own schedule.

### 5b. The key policy, which is a separate decision

An IAM policy granting `kms:Decrypt` does nothing on its own. A KMS key carries
its own resource policy and **both have to allow the call**, which is why a
bucket that is correct in every other respect still refuses the first upload.
Apply this to the key, not to the user.

```json
{
  "Version": "2012-10-17",
  "Id": "proof-of-delivery-key",
  "Statement": [
    {
      "Sid": "AccountAdministersTheKey",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::ACCOUNT_ID:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "TheApplicationUsesItThroughS3AndNowhereElse",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::ACCOUNT_ID:user/IAM_USER" },
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:ViaService": "s3.REGION.amazonaws.com" } }
    }
  ]
}
```

`"Resource": "*"` in a key policy means this key and only this key. It is not a
wildcard over the account, and it is the form AWS requires.

The `kms:ViaService` condition is what stops these credentials decrypting a
proof of delivery anywhere except through S3. If the access key leaks, the
holder can read objects whose keys they already have and cannot turn the KMS key
into a general decryption oracle. Drop the condition and that distinction goes
with it.

`kms:DescribeKey` is there because S3 calls it when resolving the bucket's
default encryption configuration. Without it the failure surfaces as an opaque
`KMS.NotFoundException` on the first PUT, which sends people looking at the
bucket policy instead of the key.

Note the credentials are long-lived access keys. The presigner does not
support STS session tokens (`x-amz-security-token`), because nothing needs
them yet; if the deployment moves to a role, that is a small addition to
`sigv4.ts` and a test.

## 6. Check it

With the values in `server/.env` and the server restarted:

```bash
curl -s -b cookies.txt http://localhost:3000/api/projects/uh/uh/files/status/check
```

`{"available":true,"reason":null}` means the configuration parsed. It does not
prove the bucket accepts a write: the first real upload does that, and a
failure at that point is almost always the CORS header list in section 4 or the
key policy in section 5b.

Then prove the other end, because a purge that cannot delete looks like a
success from inside the application: run a retention sweep against a disposable
object and confirm the object is actually gone from the bucket. A 403 there is
the missing `s3:DeleteObject`.
