#!/usr/bin/env bash
# Fixes "missing permission on the build service account" when deploying Firebase Gen2 functions.
# Requires: gcloud auth login, and Owner / Project IAM Admin (or equivalent) on the GCP project.
# Docs: https://cloud.google.com/functions/docs/troubleshooting#build-service-account
#
# Usage: ./scripts/fix-cloud-functions-build-iam.sh [PROJECT_ID]
# Example: ./scripts/fix-cloud-functions-build-iam.sh apexdashai

set -euo pipefail

PROJECT_ID="${1:-apexdashai}"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "Project: ${PROJECT_ID} (number ${PROJECT_NUMBER})"

echo "Enabling Compute Engine API (helps default compute service account resolution)..."
gcloud services enable compute.googleapis.com --project="${PROJECT_ID}"

echo "Granting Artifact Registry Writer to Cloud Build service account (${CLOUDBUILD_SA})..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CLOUDBUILD_SA}" \
  --role="roles/artifactregistry.writer"

echo "Granting Logs Writer to Cloud Build service account (build log upload)..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CLOUDBUILD_SA}" \
  --role="roles/logging.logWriter"

echo "Granting Cloud Build Builder role to default Compute service account (${COMPUTE_SA})..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/cloudbuild.builds.builder"

echo "Done. Run: firebase deploy --only functions"
