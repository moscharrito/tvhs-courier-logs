#!/usr/bin/env bash
#
# Build the proof-of-delivery bucket exactly as docs/infra/s3-bucket.md
# specifies. Read that document before running this: it explains why each of
# these settings is what it is, and this script is only the typing.
#
# WHAT IT NEEDS
#   - AWS CLI v2, authenticated as a user that can administer S3, KMS and IAM.
#   - An AWS account for Izy Global Services LLC with the BAA accepted in AWS
#     Artifact. The agreement follows the ACCOUNT. Accepting it under some
#     other account covers that account and not this one.
#
# WHAT IT DOES NOT DO
#   - It does not touch Render. It prints the six values to set there, once.
#   - It does not enable the retention lifecycle rule. That number is a
#     contract decision and the rule is created Disabled on purpose.
#
# ORDER MATTERS in three places and the script enforces it:
#   1. Versioning goes on BEFORE the first object is written. It cannot be
#      applied retroactively, and it is the only thing between an accidental
#      delete and a permanently lost photograph.
#   2. The IAM user exists before the KMS key policy, because that policy
#      names the user.
#   3. Public access is blocked before anything else touches the bucket, so
#      there is no window in which a mistake could be public.
#
# Safe to re-run. Creates are guarded; every other call is idempotent.

set -euo pipefail

# ─────────────────────────────── fill these in ───────────────────────────────

BUCKET="izy-courier-pod-767bd8"                     # globally unique across all of AWS
REGION="us-east-2"                                # a region the BAA covers
APP_ORIGIN="https://logs.izyglobalservices.com"   # exactly the origin the app is served from
IAM_USER="izy-courier-pod"
KMS_ALIAS="alias/izy-proof-of-delivery"

# ─────────────────────────────────────────────────────────────────────────────

say() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok  %s\n' "$*"; }

case "$BUCKET" in
    CHANGE-ME*|"") echo "Set BUCKET at the top of this script first." >&2; exit 1 ;;
esac
command -v aws >/dev/null || { echo "AWS CLI v2 is not on PATH." >&2; exit 1; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CALLER=$(aws sts get-caller-identity --query Arn --output text)

say "Account $ACCOUNT_ID, as $CALLER"
echo "   bucket  $BUCKET"
echo "   region  $REGION"
echo "   origin  $APP_ORIGIN"
read -r -p "   Continue? [y/N] " reply
[ "$reply" = "y" ] || { echo "Nothing done."; exit 0; }

# ───────────────────────────────── 1. the key ────────────────────────────────

say "1. KMS key"
if KEY_ARN=$(aws kms describe-key --key-id "$KMS_ALIAS" --region "$REGION" \
        --query KeyMetadata.Arn --output text 2>/dev/null); then
    ok "$KMS_ALIAS exists already"
else
    KEY_ID=$(aws kms create-key --region "$REGION" \
        --description "Izy Courier proof of delivery" \
        --key-usage ENCRYPT_DECRYPT --origin AWS_KMS \
        --query KeyMetadata.KeyId --output text)
    aws kms create-alias --region "$REGION" \
        --alias-name "$KMS_ALIAS" --target-key-id "$KEY_ID"
    aws kms enable-key-rotation --region "$REGION" --key-id "$KEY_ID"
    KEY_ARN=$(aws kms describe-key --key-id "$KEY_ID" --region "$REGION" \
        --query KeyMetadata.Arn --output text)
    ok "created, annual rotation on"
fi
echo "   $KEY_ARN"

# ──────────────────────────────── 2. the user ────────────────────────────────
# Before the key policy, because the key policy names this user.

say "2. IAM user"
if aws iam get-user --user-name "$IAM_USER" >/dev/null 2>&1; then
    ok "$IAM_USER exists already"
else
    aws iam create-user --user-name "$IAM_USER" \
        --tags Key=app,Value=izy-courier Key=purpose,Value=proof-of-delivery >/dev/null
    ok "created"
fi
USER_ARN="arn:aws:iam::${ACCOUNT_ID}:user/${IAM_USER}"

# s3:DeleteObject is REQUIRED. The retention purge signs a DELETE and sends it
# (presignDelete in core/files/storage.ts). Without it the purge marks rows
# disposed while S3 answers 403, and the database then claims a photograph is
# gone that is still sitting in the bucket.
#
# s3:DeleteObjectVersion is deliberately absent: the application may supersede
# a version, never destroy one. The lifecycle rule does that on its own clock.
#
# No s3:ListBucket: the application knows what exists from its own files
# table, not by listing the bucket.
IAM_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjectsInThisBucketAndNoOther",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "TheKeyThoseObjectsAreEncryptedWith",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "${KEY_ARN}"
    }
  ]
}
JSON
)
aws iam put-user-policy --user-name "$IAM_USER" \
    --policy-name izy-courier-pod --policy-document "$IAM_POLICY"
ok "least-privilege policy attached"

# ───────────────────────────── 3. the key policy ─────────────────────────────
# An IAM grant of kms:Decrypt does nothing on its own. The key carries its own
# resource policy and both have to allow the call. "Resource": "*" in a key
# policy means this key and only this key; it is the form AWS requires.
#
# kms:ViaService is the part worth keeping: it means a leaked access key
# cannot decrypt anything except through S3.

say "3. Key policy"
KEY_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Id": "proof-of-delivery-key",
  "Statement": [
    {
      "Sid": "AccountAdministersTheKey",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "TheApplicationUsesItThroughS3AndNowhereElse",
      "Effect": "Allow",
      "Principal": { "AWS": "${USER_ARN}" },
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:ViaService": "s3.${REGION}.amazonaws.com" } }
    }
  ]
}
JSON
)
aws kms put-key-policy --region "$REGION" --key-id "$KEY_ARN" \
    --policy-name default --policy "$KEY_POLICY"
ok "applied"

# ─────────────────────────────── 4. the bucket ───────────────────────────────

say "4. Bucket"
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
    ok "$BUCKET exists already"
elif [ "$REGION" = "us-east-1" ]; then
    # us-east-1 is the one region that must NOT be given a LocationConstraint.
    aws s3api create-bucket --bucket "$BUCKET" --region us-east-1 >/dev/null
    ok "created"
else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
        --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    ok "created"
fi

# First, so there is never a window in which a mistake is public. All four,
# not "mostly": this is a photograph of a patient's front door.
aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
ok "public access blocked, all four"

# BEFORE the first object. Versioning cannot be applied retroactively, and it
# is the backup for the half of the system a database restore does not cover:
# a snapshot restores the files row saying a photograph exists, never the
# photograph.
aws s3api put-bucket-versioning --bucket "$BUCKET" \
    --versioning-configuration Status=Enabled
ok "versioning on"

ENCRYPTION=$(cat <<JSON
{
  "Rules": [{
    "ApplyServerSideEncryptionByDefault": { "SSEAlgorithm": "aws:kms", "KMSMasterKeyID": "${KEY_ARN}" },
    "BucketKeyEnabled": true
  }]
}
JSON
)
aws s3api put-bucket-encryption --bucket "$BUCKET" \
    --server-side-encryption-configuration "$ENCRYPTION"
ok "SSE-KMS by default, bucket key on"

# ──────────────────────────── 5. the bucket policy ───────────────────────────
# Default encryption covers objects written without the headers. This refuses
# them outright, so an unencrypted write is impossible rather than merely
# discouraged. StringNotEquals also matches a request that omits the header
# entirely, which is the case that matters.

say "5. Bucket policy"
BUCKET_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyUnencryptedObjectUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::${BUCKET}/*",
      "Condition": { "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" } }
    },
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
JSON
)
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$BUCKET_POLICY"
ok "unencrypted writes and plaintext transport both refused"

# ────────────────────────────── 6. lifecycle ─────────────────────────────────
# NoncurrentVersionExpiration is part of the disposal control, not
# housekeeping: with versioning on, the application's DELETE leaves a delete
# marker and the object survives as a noncurrent version until this expires it.

say "6. Lifecycle"
LIFECYCLE=$(cat <<'JSON'
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
JSON
)
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
    --lifecycle-configuration "$LIFECYCLE"
ok "AbandonUploads enabled, RetainProofOfDelivery created DISABLED"

# ──────────────────────────────── 7. CORS ────────────────────────────────────
# The browser PUTs straight to S3. The allowed headers are exactly the ones
# the presigned PUT signs; a missing one surfaces as a CORS failure in the
# browser rather than an S3 error, which is a confusing way to find out.

say "7. CORS"
CORS=$(cat <<JSON
{
  "CORSRules": [{
    "AllowedOrigins": ["${APP_ORIGIN}"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type", "x-amz-server-side-encryption", "x-amz-server-side-encryption-aws-kms-key-id"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}
JSON
)
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "$CORS"
ok "$APP_ORIGIN only, never *"

# ───────────────────────────────── 8. verify ─────────────────────────────────

say "8. Verify"
printf '   block   %s\n' "$(aws s3api get-public-access-block --bucket "$BUCKET" \
    --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' \
    --output text)"
printf '   version %s\n' "$(aws s3api get-bucket-versioning --bucket "$BUCKET" \
    --query Status --output text)"
printf '   encrypt %s\n' "$(aws s3api get-bucket-encryption --bucket "$BUCKET" \
    --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
    --output text)"
printf '   rules   %s\n' "$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" \
    --query 'Rules[].[ID,Status]' --output text | tr '\n' ' ')"

# ──────────────────────────── 9. the access key ──────────────────────────────

say "9. Access key"
EXISTING=$(aws iam list-access-keys --user-name "$IAM_USER" \
    --query 'length(AccessKeyMetadata)' --output text)
if [ "$EXISTING" != "0" ]; then
    echo "   $IAM_USER already has $EXISTING key(s). Not creating another."
    echo "   For a fresh one, delete the old one first, and remember Render is"
    echo "   using it."
else
    KEY_JSON=$(aws iam create-access-key --user-name "$IAM_USER" \
        --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
    AK=$(echo "$KEY_JSON" | cut -f1)
    SK=$(echo "$KEY_JSON" | cut -f2)
    cat <<BANNER

   ------------------------------------------------------------------
   SHOWN ONCE. Paste these into Render's Environment tab and nowhere
   else. Not into a chat, not into the repository, not into a note.
   ------------------------------------------------------------------

     FILES_ENABLED           true
     S3_BUCKET               $BUCKET
     S3_REGION               $REGION
     S3_ACCESS_KEY_ID        $AK
     S3_SECRET_ACCESS_KEY    $SK
     S3_KMS_KEY_ID           $KEY_ARN

   Save all six together. FILES_ENABLED on its own, without the other
   five, makes the server refuse to boot: server/src/config.ts:229.
   On Render that is production going down with live TVHS drivers on it.
BANNER
fi

cat <<'NEXT'

STILL TO DO, and neither of these is typing:

  1. The retention period. RetainProofOfDelivery is DISABLED with a 2555 day
     placeholder. The same undecided number sits in
     server/src/core/retention/policy.ts. It has to be the same in both places
     or the bucket and the database will disagree about what still exists.
     Ask University Health what their records retention policy requires, set
     both, then enable the rule.

  2. Prove BOTH ends, because a purge that cannot delete looks like a success
     from inside the application:
       - one real upload succeeds
       - one retention sweep actually removes that object from the bucket
     A 403 on the second is a missing s3:DeleteObject.
NEXT
