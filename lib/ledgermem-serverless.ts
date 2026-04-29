import { Construct } from "constructs";
import {
  Duration,
  RemovalPolicy,
  aws_ec2 as ec2,
  aws_lambda as lambda,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_integrations as apigwInt,
  aws_rds as rds,
  aws_secretsmanager as secrets,
} from "aws-cdk-lib";

/**
 * Serverless flavor: Lambda + Aurora Serverless v2 + HTTP API. For low-volume / dev.
 */
export interface MnemoServerlessProps {
  readonly vpc?: ec2.IVpc;
  readonly imageTag?: string;
}

export class MnemoServerless extends Construct {
  public readonly api: apigw.HttpApi;
  public readonly fn: lambda.DockerImageFunction;
  public readonly database: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: MnemoServerlessProps = {}) {
    super(scope, id);

    const vpc = props.vpc ?? new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });

    const dbSecret = new rds.DatabaseSecret(this, "DbSecret", { username: "getmnemo" });

    this.database = new rds.DatabaseCluster(this, "Db", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_2,
      }),
      writer: rds.ClusterInstance.serverlessV2("Writer"),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: "getmnemo",
      serverlessV2MaxCapacity: 8,
      serverlessV2MinCapacity: 0.5,
      storageEncrypted: true,
      // Default RDS removal policy is DESTROY in CDK. Snapshot prevents
      // permanent data loss when the stack is torn down or replaced — even
      // the "serverless" variant gets used for staging / pilot tenants and
      // accidentally dropping the cluster has cost real customers data.
      backup: { retention: Duration.days(7) },
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    this.fn = new lambda.DockerImageFunction(this, "Fn", {
      code: lambda.DockerImageCode.fromImageAsset(".", {
        cmd: ["dist/lambda.handler"],
      }),
      memorySize: 1024,
      timeout: Duration.seconds(28),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Cluster endpoint and port are CFN tokens at synth time. Pass them via
      // `environment` (CDK resolves the tokens at deploy time) plus the secret
      // ARN so the Lambda can fetch credentials at runtime — the previous
      // version had no DB wiring at all and the function could not connect.
      environment: {
        NODE_ENV: "production",
        DB_HOST: this.database.clusterEndpoint.hostname,
        DB_PORT: this.database.clusterEndpoint.port.toString(),
        DB_NAME: "getmnemo",
        DB_SECRET_ARN: dbSecret.secretArn,
      },
    });

    dbSecret.grantRead(this.fn);
    this.database.connections.allowDefaultPortFrom(this.fn);

    this.api = new apigw.HttpApi(this, "Api");
    this.api.addRoutes({
      path: "/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration: new apigwInt.HttpLambdaIntegration("FnInt", this.fn),
    });
  }
}
