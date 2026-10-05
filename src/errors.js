export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', expose = false, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

export class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, { status: 400, code: 'validation_error', expose: true, ...options });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', options = {}) {
    super(message, { status: 401, code: 'authentication_required', expose: true, ...options });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options = {}) {
    super(message, { status: 403, code: 'forbidden', expose: true, ...options });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', options = {}) {
    super(message, { status: 404, code: 'not_found', expose: true, ...options });
  }
}

export class ConflictError extends AppError {
  constructor(message = '记录已存在', options = {}) {
    super(message, { status: 409, code: 'conflict', expose: true, ...options });
  }
}

export class UpstreamError extends AppError {
  constructor(message, options = {}) {
    super(message, { status: 502, code: 'upstream_error', expose: true, ...options });
  }
}
