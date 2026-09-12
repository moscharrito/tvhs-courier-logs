# The proof-of-delivery bucket

What has to be true of the S3 bucket before `FILES_ENABLED=true` is turned on.
None of this can be done from the application: it needs the AWS account that
ticket 0.10 sets up, under a **signed AWS Business Associate Addendum**. S3 is
a HIPAA-eligible service only when that addendum is in place.

Nothing here is applied automatically. Apply it, then set the `S3_*` values in
`server/.env`. Until then every file endpoint answers 503 and says so, rather
than appearing to store something.

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
years) is a placeholder, not advice. How long proof of delivery has to be kept
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
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "KMS_KEY_ARN"
    }
  ]
}
```

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
failure at that point is almost always the CORS header list or the KMS key
policy.
