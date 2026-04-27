import { Construct } from "constructs";
import {
  Duration,
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
export interface LedgerMemServerlessProps {
  readonly vpc?: ec2.IVpc;
  readonly imageTag?: string;
}

export class LedgerMemServerless extends Construct {
  public readonly api: apigw.HttpApi;
  public readonly fn: lambda.DockerImageFunction;
  public readonly database: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: LedgerMemServerlessProps = {}) {
    super(scope, id);

    const vpc = props.vpc ?? new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });

    const dbSecret = new rds.DatabaseSecret(this, "DbSecret", { username: "ledgermem" });

    this.database = new rds.DatabaseCluster(this, "Db", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_2,
      }),
      writer: rds.ClusterInstance.serverlessV2("Writer"),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: "ledgermem",
      serverlessV2MaxCapacity: 8,
      serverlessV2MinCapacity: 0.5,
    });

    this.fn = new lambda.DockerImageFunction(this, "Fn", {
      code: lambda.DockerImageCode.fromImageAsset(".", {
        cmd: ["dist/lambda.handler"],
      }),
      memorySize: 1024,
      timeout: Duration.seconds(28),
      vpc,
      environment: { NODE_ENV: "production" },
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
