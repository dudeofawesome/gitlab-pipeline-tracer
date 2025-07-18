#!/usr/bin/env node

import * as NodeContext from '@effect/platform-node/NodeContext'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as Effect from 'effect/Effect'
import { run } from './Cli.js'
import { OnePasswordServiceLive } from './services/1password.js'
import { GitlabServiceLive } from './services/gitlab.js'

run(process.argv).pipe(
  Effect.provide(GitlabServiceLive),
  Effect.provide([
    OnePasswordServiceLive,
    NodeContext.layer,
  ]),
  NodeRuntime.runMain({ disableErrorReporting: false }),
)
