// @flow

/* globals $PropertyType */

const EventEmitter = require('events').EventEmitter;
const WritableTrackingBuffer = require('./tracking-buffer/writable-tracking-buffer');
const TOKEN_TYPE = require('./token/token').TYPE;

const FLAGS = {
  nullable: 1 << 0,
  caseSen: 1 << 1,
  updateableReadWrite: 1 << 2,
  updateableUnknown: 1 << 3,
  identity: 1 << 4,
  computed: 1 << 5,         // introduced in TDS 7.2
  fixedLenCLRType: 1 << 8,  // introduced in TDS 7.2
  sparseColumnSet: 1 << 10, // introduced in TDS 7.3.B
  hidden: 1 << 13,          // introduced in TDS 7.2
  key: 1 << 14,             // introduced in TDS 7.2
  nullableUnknown: 1 << 15  // introduced in TDS 7.2
};

const DONE_STATUS = {
  FINAL: 0x00,
  MORE: 0x1,
  ERROR: 0x2,
  INXACT: 0x4,
  COUNT: 0x10,
  ATTN: 0x20,
  SRVERROR: 0x100
};

type InternalOptions = {
  checkConstraints: boolean,
  fireTriggers: boolean,
  keepNulls: boolean,
  lockTable: boolean,
};

type Options = {
  checkConstraints?: $PropertyType<InternalOptions, 'checkConstraints'>,
  fireTriggers?: $PropertyType<InternalOptions, 'fireTriggers'>,
  keepNulls?: $PropertyType<InternalOptions, 'keepNulls'>,
  lockTable?: $PropertyType<InternalOptions, 'lockTable'>,
};

type Column = {
  type: Object,
  name: string,
  value: null,
  output: boolean,
  length?: number,
  precision?: number,
  scale?: number,
  objName: string,
  nullable: boolean
};

type ColumnOptions = {
  output?: boolean,
  length?: number,
  precision?: number,
  scale?: number,
  objName?: string,
  nullable?: boolean
};

class BulkLoad extends EventEmitter {
  error: Error | typeof undefined;
  canceled: boolean;
  table: string;
  timeout: number | typeof undefined

  options: Object;
  callback: (err: ?Error, rowCount: number) => void;

  columns: Array<Column>;
  columnsByName: { [name: string]: Column };

  firstRowWritten: boolean;
  rowsData: WritableTrackingBuffer;

  bulkOptions: InternalOptions;

  constructor(table: string, connectionOptions: Object, {
    checkConstraints = false,
    fireTriggers = false,
    keepNulls = false,
    lockTable = false,
  }: Options, callback: (err: ?Error, rowCount: number) => void) {
    super();

    this.error = undefined;
    this.canceled = false;
    this.timeout = undefined;

    this.table = table;
    this.options = connectionOptions;
    this.callback = callback;
    this.columns = [];
    this.columnsByName = {};
    this.rowsData = new WritableTrackingBuffer(1024, 'ucs2', true);
    this.firstRowWritten = false;

    if (typeof checkConstraints !== 'boolean') {
      throw new TypeError('The "options.checkConstraints" property must be of type boolean.');
    }

    if (typeof fireTriggers !== 'boolean') {
      throw new TypeError('The "options.fireTriggers" property must be of type boolean.');
    }

    if (typeof keepNulls !== 'boolean') {
      throw new TypeError('The "options.keepNulls" property must be of type boolean.');
    }

    if (typeof lockTable !== 'boolean') {
      throw new TypeError('The "options.lockTable" property must be of type boolean.');
    }

    this.bulkOptions = { checkConstraints, fireTriggers, keepNulls, lockTable };
  }

  addColumn(name: string, type: Object, { output = false, length, precision, scale, objName = name, nullable = true }: ColumnOptions) {
    if (this.firstRowWritten) {
      throw new Error('Columns cannot be added to bulk insert after the first row has been written.');
    }

    const column = {
      type: type,
      name: name,
      value: null,
      output: output,
      length: length,
      precision: precision,
      scale: scale,
      objName: objName,
      nullable: nullable
    };

    if ((type.id & 0x30) === 0x20) {
      if (column.length == undefined && type.resolveLength) {
        column.length = type.resolveLength(column);
      }
    }

    if (type.hasPrecision) {
      if (column.precision == undefined && type.resolvePrecision) {
        column.precision = type.resolvePrecision(column);
      }
    }

    if (type.hasScale) {
      if (column.scale == undefined && type.resolveScale) {
        column.scale = type.resolveScale(column);
      }
    }

    this.columns.push(column);

    this.columnsByName[name] = column;
  }

  addRow(...input: [ { [string]: any } ] | Array<any>) {
    this.firstRowWritten = true;

    let row;
    if (input.length > 1 || !input[0] || typeof input[0] !== 'object') {
      row = input;
    } else {
      row = input[0];
    }

    // write row token
    this.rowsData.writeUInt8(TOKEN_TYPE.ROW);

    // write each column
    if (row instanceof Array) {
      for (let i = 0, len = this.columns.length; i < len; i++) {
        const c = this.columns[i];
        c.type.writeParameterData(this.rowsData, {
          length: c.length,
          scale: c.scale,
          precision: c.precision,
          value: row[i]
        }, this.options);
      }
    } else {
      for (let i = 0, len = this.columns.length; i < len; i++) {
        const c = this.columns[i];
        c.type.writeParameterData(this.rowsData, {
          length: c.length,
          scale: c.scale,
          precision: c.precision,
          value: row[c.objName]
        }, this.options);
      }
    }
  }

  getOptionsSql() {
    const addOptions = [];

    if (this.bulkOptions.checkConstraints) {
      addOptions.push('CHECK_CONSTRAINTS');
    }

    if (this.bulkOptions.fireTriggers) {
      addOptions.push('FIRE_TRIGGERS');
    }

    if (this.bulkOptions.keepNulls) {
      addOptions.push('KEEP_NULLS');
    }

    if (this.bulkOptions.lockTable) {
      addOptions.push('TABLOCK');
    }

    if (addOptions.length > 0) {
      return ` WITH (${addOptions.join(',')})`;
    } else {
      return '';
    }
  }

  getBulkInsertSql() {
    let sql = 'insert bulk ' + this.table + '(';
    for (let i = 0, len = this.columns.length; i < len; i++) {
      const c = this.columns[i];
      if (i !== 0) {
        sql += ', ';
      }
      sql += '[' + c.name + '] ' + (c.type.declaration(c));
    }
    sql += ')';

    sql += this.getOptionsSql();
    return sql;
  }

  getTableCreationSql() {
    let sql = 'CREATE TABLE ' + this.table + '(\n';
    for (let i = 0, len = this.columns.length; i < len; i++) {
      const c = this.columns[i];
      if (i !== 0) {
        sql += ',\n';
      }
      sql += '[' + c.name + '] ' + (c.type.declaration(c));
      if (c.nullable !== undefined) {
        sql += ' ' + (c.nullable ? 'NULL' : 'NOT NULL');
      }
    }
    sql += '\n)';
    return sql;
  }

  getPayload() {
    // Create COLMETADATA token
    const metaData = this.getColMetaData();
    let length = metaData.length;

    // row data
    const rows = this.rowsData.data;
    length += rows.length;

    // Create DONE token
    // It might be nice to make DoneToken a class if anything needs to create them, but for now, just do it here
    const tBuf = new WritableTrackingBuffer(this.options.tdsVersion < '7_2' ? 9 : 13);
    tBuf.writeUInt8(TOKEN_TYPE.DONE);
    const status = DONE_STATUS.FINAL;
    tBuf.writeUInt16LE(status);
    tBuf.writeUInt16LE(0); // CurCmd (TDS ignores this)
    tBuf.writeUInt32LE(0); // row count - doesn't really matter
    if (this.options.tdsVersion >= '7_2') {
      tBuf.writeUInt32LE(0); // row count is 64 bits in >= TDS 7.2
    }

    const done = tBuf.data;
    length += done.length;

    // composite payload
    const payload = new WritableTrackingBuffer(length);
    payload.copyFrom(metaData);
    payload.copyFrom(rows);
    payload.copyFrom(done);
    return payload;
  }

  getColMetaData() {
    const tBuf = new WritableTrackingBuffer(100, null, true);
    // TokenType
    tBuf.writeUInt8(TOKEN_TYPE.COLMETADATA);
    // Count
    tBuf.writeUInt16LE(this.columns.length);

    for (let j = 0, len = this.columns.length; j < len; j++) {
      const c = this.columns[j];
      // UserType
      if (this.options.tdsVersion < '7_2') {
        tBuf.writeUInt16LE(0);
      } else {
        tBuf.writeUInt32LE(0);
      }

      // Flags
      let flags = FLAGS.updateableReadWrite;
      if (c.nullable) {
        flags |= FLAGS.nullable;
      } else if (c.nullable === undefined && this.options.tdsVersion >= '7_2') {
        flags |= FLAGS.nullableUnknown;
      }
      tBuf.writeUInt16LE(flags);

      // TYPE_INFO
      c.type.writeTypeInfo(tBuf, c, this.options);

      // ColName
      tBuf.writeBVarchar(c.name, 'ucs2');
    }
    return tBuf.data;
  }

  setTimeout(timeout: number | typeof undefined) {
    this.timeout = timeout;
  }
}

module.exports = BulkLoad;
