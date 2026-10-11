import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

// The first render in a test file is slow while the whole suite runs in parallel (cold module
// imports); the default 1 s made the first `findBy…` time out now and then under load. Stays
// below vitest's 5 s test timeout.
configure({ asyncUtilTimeout: 4000 })
