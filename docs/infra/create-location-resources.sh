#!/usr/bin/env bash
#
# Create the Amazon Location resources the platform geocodes against.
#
# ─────────────────────────────────────────────────────────────────────────────
# RUN THIS ONCE, BY SOMEBODY WITH THE AWS ACCOUNT. It is not idempotent in the
# sense of fixing a wrong resource: a place index created with the wrong
# IntendedUse cannot be changed afterwards and has to be deleted and remade.
# Read the next paragraph before running it.
#
# IntendedUse=Storage IS THE WHOLE POINT, AND IS A LICENCE TERM.
#
# A place index is created as either SingleUse or Storage. SingleUse permits a
# result to be displayed and then discarded. Storage permits it to be kept.
#
# This platform writes lat/lng onto the order row and keeps it for the life of
# the record, because a run is sequenced from it and an out-of-area mile is
# billed from it. That is storage. An index created SingleUse would answer
# every call perfectly and put the company in breach on each one, with nothing
# anywhere to notice it. There is no API that reports which you chose in a way
# the application can check at boot, which is why it is written here, in
# server/src/core/geo/aws-location.ts, and in docs/infra/accounts-and-baas.md.
#
# THE BAA HAS TO NAME THIS SERVICE. Amazon Location Service is HIPAA-eligible
# and the agreement covering it was executed on 12 October 2026. Check the
# covered-services list on the countersigned copy, not a blog post.
#
# Usage:
#   ./create-location-resources.sh                 # us-east-1, default names
#   REGION=us-east-2 ./create-location-resources.sh
#
set -euo pipefail

REGION="${REGION:-us-east-1}"
PLACE_INDEX="${PLACE_INDEX:-izy-uh-places}"
ROUTE_CALCULATOR="${ROUTE_CALCULATOR:-izy-uh-routes}"

# Esri rather than Here: both are offered, both permit Storage, and Esri's
# US street coverage is the better of the two for Bexar County addresses.
DATA_SOURCE="${DATA_SOURCE:-Esri}"

echo "Region            ${REGION}"
echo "Place index       ${PLACE_INDEX}  (IntendedUse=Storage)"
echo "Route calculator  ${ROUTE_CALCULATOR}"
echo "Data source       ${DATA_SOURCE}"
echo

read -r -p "Create these in the account $(aws sts get-caller-identity --query Account --output text)? [y/N] " ok
[ "${ok}" = "y" ] || { echo "Nothing was created."; exit 1; }

aws location create-place-index \
    --region "${REGION}" \
    --index-name "${PLACE_INDEX}" \
    --data-source "${DATA_SOURCE}" \
    --data-source-configuration "IntendedUse=Storage" \
    --description "Izy Global Services: UH Pharmacy Courier. Delivery addresses are PHI; results are stored on the order row."

aws location create-route-calculator \
    --region "${REGION}" \
    --calculator-name "${ROUTE_CALCULATOR}" \
    --data-source "${DATA_SOURCE}" \
    --description "Izy Global Services: UH Pharmacy Courier. Road miles for out-of-area billing and run sequencing."

echo
echo "Created. Confirm the index really is Storage before any real address is loaded:"
echo
echo "  aws location describe-place-index --region ${REGION} --index-name ${PLACE_INDEX} \\"
echo "      --query 'DataSourceConfiguration.IntendedUse' --output text"
echo
echo "It must print Storage. If it prints SingleUse, delete the index and run this again:"
echo "  aws location delete-place-index --region ${REGION} --index-name ${PLACE_INDEX}"
echo
echo "─────────────────────────────────────────────────────────────────────────"
echo "Then, in Render's Environment tab (never in git, never in chat):"
echo
echo "  AWS_LOCATION_REGION=${REGION}"
echo "  AWS_LOCATION_PLACE_INDEX=${PLACE_INDEX}"
echo "  AWS_LOCATION_ROUTE_CALCULATOR=${ROUTE_CALCULATOR}"
echo "  AWS_LOCATION_ACCESS_KEY_ID=..."
echo "  AWS_LOCATION_SECRET_ACCESS_KEY=..."
echo "  GEO_BAA_COVERS_PATIENT_ADDRESSES=true"
echo
echo "The access key wants its own IAM user with ONLY these two actions, on"
echo "these two resources. Not the bucket's key: that one can read patient"
echo "photographs, and one credential that can do both is a worse day when it"
echo "leaks."
echo
cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "geo:SearchPlaceIndexForText",
      "Resource": "arn:aws:geo:${REGION}:*:place-index/${PLACE_INDEX}"
    },
    {
      "Effect": "Allow",
      "Action": "geo:CalculateRoute",
      "Resource": "arn:aws:geo:${REGION}:*:route-calculator/${ROUTE_CALCULATOR}"
    }
  ]
}
JSON
echo
echo "Without GEO_BAA_COVERS_PATIENT_ADDRESSES the platform geocodes pharmacy"
echo "addresses only and refuses delivery addresses, which is the safe default"
echo "and is what it does today."
