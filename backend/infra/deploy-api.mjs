// Puts API Gateway (REST, regional) + AWS WAF in front of the leaderboard
// Lambda, so the Lambda itself is no longer public. Safe to re-run: each step
// looks for what already exists before creating anything.
//
//   npm run deploy-api            create/update the API, WAF and permissions
//   npm run remove-function-url   delete the old public Function URL + its '*' statements
//   npm run status                print what exists, change nothing
//
// Uses the AWS profile in AWS_PROFILE (default: lueka-dev).
import {
  APIGatewayClient, GetRestApisCommand, CreateRestApiCommand, GetResourcesCommand,
  CreateResourceCommand, PutMethodCommand, PutIntegrationCommand, CreateDeploymentCommand,
  GetStageCommand, UpdateStageCommand
} from "@aws-sdk/client-api-gateway";
import {
  LambdaClient, GetFunctionCommand, GetPolicyCommand, AddPermissionCommand, RemovePermissionCommand,
  GetFunctionUrlConfigCommand, DeleteFunctionUrlConfigCommand
} from "@aws-sdk/client-lambda";
import {
  WAFV2Client, ListWebACLsCommand, CreateWebACLCommand, GetWebACLCommand,
  GetWebACLForResourceCommand, AssociateWebACLCommand
} from "@aws-sdk/client-wafv2";
import { fromIni } from "@aws-sdk/credential-providers";

const REGION = "us-west-2";
const PROFILE = process.env.AWS_PROFILE || "lueka-dev";
const FUNCTION = "ee-connections-leaderboard";
const API_NAME = "ee-connections-leaderboard";
const STAGE = "prod";
const ACL_NAME = "ee-connections-leaderboard-acl";
const APIGW_STATEMENT = "apigateway-invoke";
const PUBLIC_STATEMENTS = ["public-url", "public-url-invoke"];

// Throttling for the whole stage. A team answering once a day is a handful of
// requests; this only exists to stop floods.
const THROTTLE = { rateLimit: 10, burstLimit: 20 };
// WAF rate rule: requests per 5 minutes per source IP. Kept high because many
// people on the corporate network share a few egress IPs.
const WAF_RATE_LIMIT = 1000;

const credentials = fromIni({ profile: PROFILE });
const apigw = new APIGatewayClient({ region: REGION, credentials });
const lambda = new LambdaClient({ region: REGION, credentials });
const waf = new WAFV2Client({ region: REGION, credentials });

const log = (...a) => console.log(...a);

async function getFunctionArn() {
  const f = await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION }));
  return f.Configuration.FunctionArn;
}

async function findApi() {
  let position;
  do {
    const page = await apigw.send(new GetRestApisCommand({ limit: 500, position }));
    const hit = (page.items || []).find((a) => a.name === API_NAME);
    if (hit) return hit;
    position = page.position;
  } while (position);
  return null;
}

async function ensureApi() {
  const existing = await findApi();
  if (existing) {
    log(`API exists: ${existing.id}`);
    return existing.id;
  }
  const api = await apigw.send(new CreateRestApiCommand({
    name: API_NAME,
    description: "EE Connections leaderboard (fronts the Lambda; WAF attached)",
    endpointConfiguration: { types: ["REGIONAL"] }
  }));
  log(`API created: ${api.id}`);
  return api.id;
}

async function ensureProxy(apiId, functionArn) {
  const { items } = await apigw.send(new GetResourcesCommand({ restApiId: apiId, limit: 500 }));
  const root = items.find((r) => r.path === "/");
  let proxy = items.find((r) => r.path === "/{proxy+}");
  if (!proxy) {
    proxy = await apigw.send(new CreateResourceCommand({ restApiId: apiId, parentId: root.id, pathPart: "{proxy+}" }));
    log("Created /{proxy+}");
  }
  const hasAny = proxy.resourceMethods && proxy.resourceMethods.ANY;
  if (!hasAny) {
    await apigw.send(new PutMethodCommand({
      restApiId: apiId, resourceId: proxy.id, httpMethod: "ANY", authorizationType: "NONE"
    }));
    log("Created ANY method");
  }
  // PutIntegration overwrites, so always set it (cheap and keeps it correct).
  await apigw.send(new PutIntegrationCommand({
    restApiId: apiId, resourceId: proxy.id, httpMethod: "ANY",
    type: "AWS_PROXY", integrationHttpMethod: "POST",
    uri: `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${functionArn}/invocations`
  }));
  log("Lambda proxy integration set");
}

async function currentPolicyStatements() {
  try {
    const p = await lambda.send(new GetPolicyCommand({ FunctionName: FUNCTION }));
    return JSON.parse(p.Policy).Statement || [];
  } catch (err) {
    if (err.name === "ResourceNotFoundException") return [];
    throw err;
  }
}

async function ensureApiPermission(apiId) {
  const account = (await getFunctionArn()).split(":")[4];
  const sourceArn = `arn:aws:execute-api:${REGION}:${account}:${apiId}/${STAGE}/*/*`;
  const statements = await currentPolicyStatements();
  const existing = statements.find((s) => s.Sid === APIGW_STATEMENT);
  if (existing && JSON.stringify(existing).includes(sourceArn)) {
    log("Lambda permission for API Gateway already set");
    return;
  }
  if (existing) await lambda.send(new RemovePermissionCommand({ FunctionName: FUNCTION, StatementId: APIGW_STATEMENT }));
  // Only this API's prod stage may invoke the function: a specific service
  // principal plus SourceArn, not '*'.
  await lambda.send(new AddPermissionCommand({
    FunctionName: FUNCTION, StatementId: APIGW_STATEMENT, Action: "lambda:InvokeFunction",
    Principal: "apigateway.amazonaws.com", SourceArn: sourceArn
  }));
  log(`Lambda permission added for ${sourceArn}`);
}

async function ensureStage(apiId) {
  await apigw.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: STAGE, description: "deploy-api.mjs" }));
  await apigw.send(new UpdateStageCommand({
    restApiId: apiId, stageName: STAGE,
    patchOperations: [
      { op: "replace", path: "/*/*/throttling/rateLimit", value: String(THROTTLE.rateLimit) },
      { op: "replace", path: "/*/*/throttling/burstLimit", value: String(THROTTLE.burstLimit) }
    ]
  }));
  log(`Deployed stage ${STAGE} (throttle ${THROTTLE.rateLimit} rps, burst ${THROTTLE.burstLimit})`);
}

async function findAcl() {
  let NextMarker;
  do {
    const page = await waf.send(new ListWebACLsCommand({ Scope: "REGIONAL", Limit: 100, NextMarker }));
    const hit = (page.WebACLs || []).find((a) => a.Name === ACL_NAME);
    if (hit) return hit;
    NextMarker = page.NextMarker;
  } while (NextMarker);
  return null;
}

const visibility = (name) => ({ SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: name });

async function ensureAcl() {
  const existing = await findAcl();
  if (existing) {
    log(`WAF web ACL exists: ${existing.ARN}`);
    return existing.ARN;
  }
  const res = await waf.send(new CreateWebACLCommand({
    Name: ACL_NAME, Scope: "REGIONAL", DefaultAction: { Allow: {} },
    Description: "EE Connections leaderboard API",
    VisibilityConfig: visibility("eeLeaderboardAcl"),
    Rules: [
      {
        // Per-IP flood protection.
        Name: "rate-limit-per-ip", Priority: 0, Action: { Block: {} },
        Statement: { RateBasedStatement: { Limit: WAF_RATE_LIMIT, AggregateKeyType: "IP" } },
        VisibilityConfig: visibility("eeRateLimit")
      },
      {
        // Known-bad IPs (botnets, scanners) from Amazon threat intel.
        Name: "aws-ip-reputation", Priority: 1, OverrideAction: { None: {} },
        Statement: { ManagedRuleGroupStatement: { VendorName: "AWS", Name: "AWSManagedRulesAmazonIpReputationList" } },
        VisibilityConfig: visibility("eeIpReputation")
      },
      {
        // OWASP-style protections (bad inputs, oversized bodies, etc.).
        Name: "aws-common", Priority: 2, OverrideAction: { None: {} },
        Statement: { ManagedRuleGroupStatement: { VendorName: "AWS", Name: "AWSManagedRulesCommonRuleSet" } },
        VisibilityConfig: visibility("eeCommon")
      },
      {
        // Only the three routes the app uses; everything else is rejected at
        // the edge before reaching the Lambda.
        Name: "allow-known-routes-only", Priority: 3, Action: { Block: {} },
        Statement: {
          NotStatement: {
            Statement: {
              RegexMatchStatement: {
                RegexString: `^/${STAGE}/(register|answer|leaderboard)$`,
                FieldToMatch: { UriPath: {} },
                TextTransformations: [{ Priority: 0, Type: "NONE" }]
              }
            }
          }
        },
        VisibilityConfig: visibility("eeKnownRoutes")
      }
    ]
  }));
  log(`WAF web ACL created: ${res.Summary.ARN}`);
  return res.Summary.ARN;
}

async function ensureAclAssociation(apiId, aclArn) {
  const stageArn = `arn:aws:apigateway:${REGION}::/restapis/${apiId}/stages/${STAGE}`;
  const current = await waf.send(new GetWebACLForResourceCommand({ ResourceArn: stageArn }));
  if (current.WebACL && current.WebACL.ARN === aclArn) {
    log("WAF already associated with the stage");
    return;
  }
  // A brand-new stage can take a few seconds before WAF accepts it.
  for (let attempt = 1; ; attempt++) {
    try {
      await waf.send(new AssociateWebACLCommand({ WebACLArn: aclArn, ResourceArn: stageArn }));
      log("WAF associated with the stage");
      return;
    } catch (err) {
      if (attempt >= 6 || err.name !== "WAFUnavailableEntityException") throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function removeFunctionUrl() {
  try {
    await lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: FUNCTION }));
    log("Deleted the public Function URL");
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
    log("No Function URL to delete");
  }
  // Deleting the URL doesn't remove its policy statements; remove the '*' ones.
  const statements = await currentPolicyStatements();
  for (const sid of PUBLIC_STATEMENTS) {
    if (statements.some((s) => s.Sid === sid)) {
      await lambda.send(new RemovePermissionCommand({ FunctionName: FUNCTION, StatementId: sid }));
      log(`Removed policy statement ${sid}`);
    }
  }
  const left = (await currentPolicyStatements()).filter((s) => s.Principal === "*" || (s.Principal && s.Principal.AWS === "*"));
  log(left.length ? `WARNING: still public statements: ${left.map((s) => s.Sid).join(", ")}` : "No '*' principals left in the Lambda policy");
}

async function status() {
  const api = await findApi();
  log("API:", api ? `${api.id} -> https://${api.id}.execute-api.${REGION}.amazonaws.com/${STAGE}` : "none");
  if (api) {
    try {
      const s = await apigw.send(new GetStageCommand({ restApiId: api.id, stageName: STAGE }));
      log("Stage:", STAGE, "web ACL:", s.webAclArn || "none");
    } catch { log("Stage: none"); }
  }
  try {
    const u = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: FUNCTION }));
    log("Function URL:", u.AuthType, u.FunctionUrl);
  } catch { log("Function URL: none"); }
  for (const s of await currentPolicyStatements()) {
    log("Policy statement:", s.Sid, JSON.stringify(s.Principal), s.Action);
  }
}

const args = process.argv.slice(2);
if (args.includes("--status")) {
  await status();
} else if (args.includes("--remove-function-url")) {
  await removeFunctionUrl();
  await status();
} else {
  const functionArn = await getFunctionArn();
  const apiId = await ensureApi();
  await ensureProxy(apiId, functionArn);
  await ensureApiPermission(apiId);
  await ensureStage(apiId);
  const aclArn = await ensureAcl();
  await ensureAclAssociation(apiId, aclArn);
  log(`\nAPI URL: https://${apiId}.execute-api.${REGION}.amazonaws.com/${STAGE}`);
}
