import { Construct } from "constructs";
import {
  Stack,
  Duration,
  RemovalPolicy,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecs_patterns as ecsPatterns,
  aws_rds as rds,
  aws_elasticache as elasticache,
  aws_secretsmanager as secrets,
  aws_certificatemanager as acm,
  aws_route53 as route53,
} from "aws-cdk-lib";

/**
 * Props for {@link LedgerMemCluster} — production AWS deployment of LedgerMem.
 *
 * Architecture: Fargate Service (API + worker) + Aurora PostgreSQL with pgvector
 * + ElastiCache Redis + ALB with TLS. Image is pulled from ghcr.io/ledgermem/api.
 */
export interface LedgerMemClusterProps {
  /** VPC to deploy into. If omitted, a new VPC with NAT is created. */
  readonly vpc?: ec2.IVpc;

  /** Domain name for the ALB (e.g. memory.example.com). Requires `hostedZone`. */
  readonly domainName?: string;

  /** Hosted zone for the domain. Required if `domainName` is set. */
  readonly hostedZone?: route53.IHostedZone;

  /** ACM certificate for TLS. If omitted and `domainName` is set, one is provisioned via DNS validation. */
  readonly certificate?: acm.ICertificate;

  /** Container image. Defaults to `ghcr.io/ledgermem/api:latest`. */
  readonly imageTag?: string;

  /** Desired task count for the API service. Defaults to 2. */
  readonly desiredCount?: number;

  /** CPU units per task (256, 512, 1024, 2048, 4096). Defaults to 1024. */
  readonly cpu?: number;

  /** Memory MiB per task. Defaults to 2048. */
  readonly memoryLimitMiB?: number;

  /** Aurora instance type. Defaults to db.r6g.large. */
  readonly auroraInstanceClass?: ec2.InstanceClass;

  /** Aurora instance size. Defaults to LARGE. */
  readonly auroraInstanceSize?: ec2.InstanceSize;
}

/**
 * High-level construct that provisions a production LedgerMem deployment on AWS.
 *
 * @example
 * new LedgerMemCluster(this, "LedgerMem", {
 *   domainName: "memory.example.com",
 *   hostedZone: route53.HostedZone.fromLookup(this, "Z", { domainName: "example.com" }),
 * });
 */
export class LedgerMemCluster extends Construct {
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;
  public readonly database: rds.DatabaseCluster;
  public readonly cache: elasticache.CfnReplicationGroup;
  public readonly apiKeySecret: secrets.Secret;

  constructor(scope: Construct, id: string, props: LedgerMemClusterProps = {}) {
    super(scope, id);

    const vpc =
      props.vpc ?? new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });

    // --- Postgres (Aurora with pgvector preinstalled via parameter group)
    const dbSecret = new rds.DatabaseSecret(this, "DbSecret", {
      username: "ledgermem",
    });

    const parameterGroup = new rds.ParameterGroup(this, "DbParams", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_2,
      }),
      parameters: {
        shared_preload_libraries: "pg_stat_statements,vector",
      },
    });

    this.database = new rds.DatabaseCluster(this, "Db", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_2,
      }),
      writer: rds.ClusterInstance.provisioned("Writer", {
        instanceType: ec2.InstanceType.of(
          props.auroraInstanceClass ?? ec2.InstanceClass.R6G,
          props.auroraInstanceSize ?? ec2.InstanceSize.LARGE,
        ),
      }),
      readers: [rds.ClusterInstance.serverlessV2("Reader")],
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      credentials: rds.Credentials.fromSecret(dbSecret),
      parameterGroup,
      defaultDatabaseName: "ledgermem",
      backup: { retention: Duration.days(14) },
      storageEncrypted: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    // --- Redis (replication group so transit + at-rest encryption are available;
    //     CfnCacheCluster does not support TransitEncryptionEnabled).
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, "CacheSubnets", {
      description: "LedgerMem Redis",
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
    });

    const cacheSg = new ec2.SecurityGroup(this, "CacheSg", {
      vpc,
      allowAllOutbound: true,
    });

    const cacheReplicationGroup = new elasticache.CfnReplicationGroup(this, "CacheRG", {
      replicationGroupDescription: "LedgerMem Redis (TLS)",
      engine: "redis",
      cacheNodeType: "cache.t4g.medium",
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      cacheSubnetGroupName: cacheSubnetGroup.ref,
      securityGroupIds: [cacheSg.securityGroupId],
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
    });

    this.cache = cacheReplicationGroup;

    // --- API key secret
    this.apiKeySecret = new secrets.Secret(this, "ApiKey", {
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 40,
      },
    });

    // --- Fargate service behind ALB
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const cert =
      props.certificate ??
      (props.domainName && props.hostedZone
        ? new acm.Certificate(this, "Cert", {
            domainName: props.domainName,
            validation: acm.CertificateValidation.fromDns(props.hostedZone),
          })
        : undefined);

    this.service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Api", {
      cluster,
      desiredCount: props.desiredCount ?? 2,
      cpu: props.cpu ?? 1024,
      memoryLimitMiB: props.memoryLimitMiB ?? 2048,
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry(
          `ghcr.io/ledgermem/api:${props.imageTag ?? "latest"}`,
        ),
        containerPort: 4100,
        environment: {
          NODE_ENV: "production",
          PORT: "4100",
        },
        secrets: {
          DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
          API_KEY: ecs.Secret.fromSecretsManager(this.apiKeySecret),
        },
      },
      domainName: props.domainName,
      domainZone: props.hostedZone,
      certificate: cert,
      redirectHTTP: !!cert,
      publicLoadBalancer: true,
    });

    // Allow service to reach DB + cache
    this.database.connections.allowDefaultPortFrom(this.service.service);
    cacheSg.addIngressRule(
      this.service.service.connections.securityGroups[0]!,
      ec2.Port.tcp(6379),
    );

    // Health check
    this.service.targetGroup.configureHealthCheck({ path: "/healthz" });

    // Output
    new (Stack.of(this).node.tryGetContext("CfnOutput") ?? Object)?.constructor?.(
      this,
      "ServiceUrl",
      { value: this.service.loadBalancer.loadBalancerDnsName },
    );
  }
}
