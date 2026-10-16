# Backend Deployment Guide

## Architecture

```
You (paste wiki content) → Lambda (Bedrock generates questions) → S3 (hosts questions.json)
                                                                       ↑
                                              EE Connections app fetches on startup
```

## Setup (one-time)

### 1. Create S3 Bucket

```bash
aws s3 mb s3://ee-connections-questions --region us-west-2
```

Enable public read (so the Electron app can fetch without auth):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadQuestions",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::ee-connections-questions/questions.json"
    }
  ]
}
```

```bash
aws s3api put-bucket-policy --bucket ee-connections-questions --policy file://bucket-policy.json
```

### 2. Upload Initial Questions

```bash
aws s3 cp ../data/questions.json s3://ee-connections-questions/questions.json
```

### 3. Create Lambda

```bash
cd lambda
npm install
zip -r function.zip .
aws lambda create-function \
  --function-name ee-connections-generate \
  --runtime nodejs20.x \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/ee-connections-lambda-role \
  --timeout 60 \
  --memory-size 256 \
  --environment "Variables={QUESTIONS_BUCKET=ee-connections-questions}" \
  --region us-west-2
```

### 4. Create IAM Role

The Lambda role needs:
- `bedrock:InvokeModel` on Claude model
- `s3:GetObject` and `s3:PutObject` on the questions bucket

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::ee-connections-questions/*"
    }
  ]
}
```

### 5. Create Function URL (simplest way to invoke)

```bash
aws lambda create-function-url-config \
  --function-name ee-connections-generate \
  --auth-type NONE \
  --region us-west-2
```

This gives you a URL like: `https://abc123.lambda-url.us-west-2.on.aws/`

## Usage

### Adding Questions from Wiki Content

```bash
curl -X POST https://YOUR_LAMBDA_URL/ \
  -H "Content-Type: application/json" \
  -d '{
    "sourceText": "Paste your Confluence page content here...",
    "numQuestions": 10
  }'
```

Or use the local helper script:

```bash
node feed-questions.mjs "paste or pipe wiki text here"
```

## Updating the Lambda

```bash
cd lambda
npm install
zip -r function.zip .
aws lambda update-function-code \
  --function-name ee-connections-generate \
  --zip-file fileb://function.zip \
  --region us-west-2
```

---

# Leaderboard

## Architecture

```
App ──POST /register, POST /answer, GET /leaderboard──▶ Lambda (Function URL) ──▶ DynamoDB
                                                           │
                                         fetches questions.json from GitHub to grade answers
```

- Players are identified by Amazon alias, taken from the Windows login name (override with the `EE_ALIAS` environment variable).
- On first use each install registers its alias and gets a secret token. The first install to register an alias owns it.
- The app sends only which option was picked. The Lambda grades it against `questions.json` and accepts one answer per person per day and one per question.
- Scores are total correct answers: a weekly board (Monday–Sunday, by the player's local date) and an all-time board. Ties go to fewer attempts.
- Only answers given after the leaderboard goes live count; earlier local history isn't uploaded.

The code is in `backend/leaderboard/` (`leaderboard.mjs` is the logic, `index.mjs` the DynamoDB/Lambda wiring). It has no dependencies because the Node.js 22 Lambda runtime includes AWS SDK v3.

## Current deployment

| | |
|---|---|
| Account | `lueka-dev` (652656942138), us-west-2 |
| CLI profile | `lueka-dev` (`credential_process = ada credentials print --account 652656942138 --provider isengard --role lueka-dev`) |
| URL | `https://u33gtnkqhgvhiwpjmb26ke3lma0gieha.lambda-url.us-west-2.on.aws` |
| Resources | table `ee-connections-leaderboard`, role `ee-connections-leaderboard-role`, function `ee-connections-leaderboard` |

Add `--profile lueka-dev` to the commands below.

## Setup (one-time, PowerShell)

Replace `YOUR_ACCOUNT_ID` here and in `leaderboard/policy.json`.

### 1. DynamoDB table

```powershell
aws dynamodb create-table --table-name ee-connections-leaderboard `
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S `
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE `
  --billing-mode PAY_PER_REQUEST --region us-west-2

aws dynamodb update-continuous-backups --table-name ee-connections-leaderboard `
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true --region us-west-2
```

### 2. IAM role

```powershell
'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' |
  Set-Content trust.json
aws iam create-role --role-name ee-connections-leaderboard-role --assume-role-policy-document file://trust.json
aws iam attach-role-policy --role-name ee-connections-leaderboard-role `
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name ee-connections-leaderboard-role `
  --policy-name leaderboard-table --policy-document file://leaderboard/policy.json
```

### 3. Lambda

```powershell
Compress-Archive -Force leaderboard\index.mjs, leaderboard\leaderboard.mjs leaderboard.zip
aws lambda create-function --function-name ee-connections-leaderboard `
  --runtime nodejs22.x --handler index.handler --zip-file fileb://leaderboard.zip `
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/ee-connections-leaderboard-role `
  --timeout 10 --memory-size 256 `
  --environment "Variables={TABLE_NAME=ee-connections-leaderboard}" --region us-west-2

# Caps runaway traffic (and cost); plenty for a team-sized app.
aws lambda put-function-concurrency --function-name ee-connections-leaderboard `
  --reserved-concurrent-executions 5 --region us-west-2
```

### 4. Function URL

```powershell
aws lambda create-function-url-config --function-name ee-connections-leaderboard `
  --auth-type NONE --region us-west-2
aws lambda add-permission --function-name ee-connections-leaderboard `
  --statement-id public-url --action lambda:InvokeFunctionUrl --principal "*" `
  --function-url-auth-type NONE --region us-west-2
aws lambda add-permission --function-name ee-connections-leaderboard `
  --statement-id public-url-invoke --action lambda:InvokeFunction --principal "*" `
  --invoked-via-function-url --region us-west-2
```

A public (`NONE`) URL needs **both** statements. With only the first, every request returns `403 Forbidden`. The second is limited to calls made through the URL, so it doesn't open other ways to invoke the function. `--invoked-via-function-url` needs a recent AWS CLI (2.27.27 doesn't have it). With an older CLI, use the console (function → Configuration → Permissions → Add permissions → Function URL → NONE), or the SDK's `AddPermissionCommand` with `InvokedViaFunctionUrl: true`. The SDK route is how the current deployment was done.

The URL is reachable from the internet. Writes need a per-alias token, but anyone can read the board or claim an alias that hasn't registered yet. Nothing beyond alias and scores is stored.

Smoke test (should return a 400 about the date, which shows the function and table are wired up):

```powershell
curl.exe "https://YOUR_URL.lambda-url.us-west-2.on.aws/leaderboard?alias=test&date=bad"
```

### 5. Point the app at it

Put the URL (no trailing slash) as the default `LEADERBOARD_URL` in `main.js`, then rebuild (`npm run build`) and redistribute the installer. Code changes don't reach existing installs through the GitHub question sync; people need the new build.

## Operations

Update the code:

```powershell
Compress-Archive -Force leaderboard\index.mjs, leaderboard\leaderboard.mjs leaderboard.zip
aws lambda update-function-code --function-name ee-connections-leaderboard `
  --zip-file fileb://leaderboard.zip --region us-west-2
```

Reset an alias (for a reinstall that lost its token, or a squatted alias). Their scores stay, and the rightful owner's app re-registers the next time it launches:

```powershell
aws dynamodb delete-item --table-name ee-connections-leaderboard `
  --key '{\"pk\":{\"S\":\"USER#alias\"},\"sk\":{\"S\":\"PROFILE\"}}' --region us-west-2
```
