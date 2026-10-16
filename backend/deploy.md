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
App ──POST /register, POST /answer, GET /leaderboard──▶ AWS WAF ──▶ API Gateway (REST, prod stage) ──▶ Lambda ──▶ DynamoDB
                                                                                                      │
                                                                    fetches questions.json from GitHub to grade answers
```

The Lambda is **not** public. Its only resource-policy statement lets `apigateway.amazonaws.com` invoke it, scoped by `SourceArn` to this API's `prod` stage. An earlier version used a public Lambda Function URL (`Principal: "*"`), which security tooling flags as Critical; don't bring that back.

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
| URL | `https://3yfrz9m69b.execute-api.us-west-2.amazonaws.com/prod` |
| Resources | table `ee-connections-leaderboard`, role `ee-connections-leaderboard-role`, function `ee-connections-leaderboard`, REST API `ee-connections-leaderboard` (`3yfrz9m69b`), WAF web ACL `ee-connections-leaderboard-acl` |

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

### 4. API Gateway + WAF

Scripted with the AWS SDK in `backend/infra/` (the AWS CLI on this machine is too old for some of these calls). It's safe to re-run: each step reuses what exists.

```powershell
cd backend\infra
npm install
$env:AWS_PROFILE = "lueka-dev"   # default if unset
npm run deploy-api               # prints the API URL at the end
npm run status                   # show what exists, change nothing
```

`deploy-api` creates:
- **REST API** `ee-connections-leaderboard` (regional) with `/{proxy+}` → `ANY` → Lambda proxy integration, deployed to stage `prod`. Stage throttling is 10 requests/s, burst 20.
- **Lambda permission** `apigateway-invoke`: principal `apigateway.amazonaws.com`, `SourceArn arn:aws:execute-api:us-west-2:<account>:<api-id>/prod/*/*`.
- **WAF web ACL** `ee-connections-leaderboard-acl`, associated with the stage:
  - rate limit of 1,000 requests per 5 minutes per IP (kept high because corporate egress IPs are shared)
  - AWS managed IP reputation list
  - AWS managed common rule set
  - a rule blocking every path except `/prod/register`, `/prod/answer` and `/prod/leaderboard`

WAF costs about $5/month for the web ACL plus about $1/month per rule (four here), plus $0.60 per million requests. API Gateway and Lambda at this volume stay in the cents.

If an old public Function URL still exists, remove it along with its `"*"` policy statements:

```powershell
npm run remove-function-url
```

The API is still reachable from the internet. Writes need a per-alias token, but anyone can read the board or claim an alias that hasn't registered yet. Nothing beyond alias and scores is stored.

End-to-end check with a throwaway alias. It registers, answers, checks the board and blocked routes, then deletes its own data:

```powershell
npm run smoke-test -- https://<api-id>.execute-api.us-west-2.amazonaws.com/prod
```

### 5. Point the app at it

Put the API URL (including `/prod`, no trailing slash) as the default `LEADERBOARD_URL` in `main.js`, then rebuild (`npm run build`) and redistribute the installer. Code changes don't reach existing installs through the GitHub question sync; people need the new build.

## Operations

Update the code:

```powershell
Compress-Archive -Force leaderboard\index.mjs, leaderboard\leaderboard.mjs leaderboard.zip
aws lambda update-function-code --function-name ee-connections-leaderboard `
  --zip-file fileb://leaderboard.zip --region us-west-2
```

Reset an alias. Use this when someone's app says their alias is "already registered from another install", for example after a reinstall that lost the token, or a squatted alias. It deletes only the registration; their answers and scores stay. Their app re-registers the next time it starts (quit from the tray icon and reopen):

```powershell
cd backend\infra
npm run inspect-alias -- <alias>   # read-only: table rows + local progress.json state
npm run reset-alias -- <alias>
```
