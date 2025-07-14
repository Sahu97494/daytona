import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1752067215297 implements MigrationInterface {
  name = 'Migration1752067215297'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runner" ADD "version" character varying NOT NULL DEFAULT '0'`)
    await queryRunner.query(`ALTER TABLE "runner" ADD "proxyUrl" character varying NOT NULL DEFAULT ''`)
    // Copy apiUrl to proxyUrl for all existing records
    await queryRunner.query(`UPDATE "runner" SET "proxyUrl" = "apiUrl"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Optionally clear proxyUrl before dropping
    await queryRunner.query(`UPDATE "runner" SET "proxyUrl" = NULL`)
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "version"`)
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "proxyUrl"`)
  }
}
