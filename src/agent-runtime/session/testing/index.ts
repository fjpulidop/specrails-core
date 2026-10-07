/**
 * Test kit for hosts and driver authors (package export `./agent-runtime/session/testing`).
 * Framework-free: usable from any test runner.
 */
export { DRIVER_CONFORMANCE, type ConformanceCheck, type ConformanceHarness } from './driver-conformance.js'
export { FixtureReplayer, loadFixture, type FixtureRow, type ReplaySession } from './fixture-replayer.js'
export { MemoryJournal } from './memory-journal.js'
export { FakeClock, SequentialIds } from './fake-clock.js'
export { ScriptedDriverFactory, ScriptedDriverSession, catalogOf, descriptor } from './scripted-driver.js'
