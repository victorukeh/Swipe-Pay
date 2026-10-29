import { ApiProperty } from '@nestjs/swagger';

export class HealthFxCheck {
  @ApiProperty({ description: 'False only when no tier of the rate chain could answer.' })
  reachable!: boolean;

  @ApiProperty({
    description: 'Which tier served the last rate lookup.',
    enum: ['live', 'cached', 'stale', 'fallback'],
    nullable: true,
    example: 'live',
  })
  source!: string | null;

  @ApiProperty({ nullable: true, example: '2026-10-29T08:00:00.000Z' })
  asOf!: string | null;

  @ApiProperty({
    description:
      'True only when the live provider could not be reached. A warm cache is the normal ' +
      'operating mode and is not degradation.',
  })
  degraded!: boolean;
}

export class HealthChecks {
  @ApiProperty({ description: 'PostgreSQL reachable. Load-bearing: false means `down`.' })
  database!: boolean;

  @ApiProperty({ description: 'Redis reachable. False degrades but does not stop the API.' })
  redis!: boolean;

  @ApiProperty({ description: 'Active currencies loaded at boot.', example: 5 })
  currencies!: number;

  @ApiProperty({ type: HealthFxCheck })
  fx!: HealthFxCheck;
}

export class HealthResponseDto {
  @ApiProperty({
    description:
      '`ok` when everything is reachable. `degraded` when Redis is down or rates have fallen ' +
      'back to a snapshot or the static table -- the API still works. `down`, with a 503, only ' +
      'when PostgreSQL is unreachable, since no money can move then.',
    enum: ['ok', 'degraded', 'down'],
    example: 'ok',
  })
  status!: 'ok' | 'degraded' | 'down';

  @ApiProperty({ type: HealthChecks })
  checks!: HealthChecks;
}
