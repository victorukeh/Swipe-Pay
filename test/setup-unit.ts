// Unit tests must stay hermetic: no database, no Redis, no network.
import 'reflect-metadata';

jest.setTimeout(10_000);
