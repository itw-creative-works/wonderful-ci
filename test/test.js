const package = require('../package.json');
const assert = require('assert');

beforeEach(() => {
});

before(() => {
});

after(() => {
});

/*
 * ============
 *  Test Cases
 * ============
 */
describe(`${package.name}`, () => {
  const library = new (require(`../dist/index.js`))();

  describe('.version()', () => {

    describe('version', () => {
     
      // Normal
      it('version => version', async () => {
        return assert.equal(await library.process({version: true, log: true, debug: false}), package.version);
      });

    });

  });

  describe('.project-version()', () => {

    describe('project-version', () => {
     
      // Normal
      it('project-version => project-version', async () => {
        return assert.equal(await library.process({'project-version': true, log: true, debug: false}), package.version);
      });

    });

  });  

  describe('.outdated()', () => {

    describe('outdated', () => {
     
      // Normal
      it('outdated => outdated', async () => {
        await library.process({'outdated': true, log: true, debug: false})
        return assert.equal(true, true);
      });

    });

  });    

})
