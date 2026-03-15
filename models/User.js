const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 3,
        maxlength: 30
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    passwordHash: {
        type: String,
        required: true
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    banned: {
        type: Boolean,
        default: false
    },
    resetToken: { type: String },
    resetTokenExpiry: { type: Date },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Hash password with bcrypt before saving
userSchema.pre('save', async function (next) {
    if (!this.isModified('passwordHash')) return next();
    try {
        this.passwordHash = await bcrypt.hash(this.passwordHash, 10);
        next();
    } catch (err) {
        next(err);
    }
});

userSchema.methods.comparePassword = async function (password) {
    if (this.passwordHash.startsWith('$2')) {
        return bcrypt.compare(password, this.passwordHash);
    }
    // Legacy Base64: decode, compare, then migrate to bcrypt on successful login
    try {
        const decoded = Buffer.from(this.passwordHash, 'base64').toString('utf-8');
        if (decoded !== password) return false;
        this.passwordHash = await bcrypt.hash(password, 10);
        await this.save({ validateBeforeSave: false });
        return true;
    } catch (e) {
        return false;
    }
};

userSchema.methods.createResetToken = function () {
    const token = crypto.randomBytes(32).toString('hex');
    this.resetToken = token;
    this.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    return token;
};

userSchema.methods.clearResetToken = function () {
    this.resetToken = undefined;
    this.resetTokenExpiry = undefined;
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.passwordHash;
    delete obj.resetToken;
    delete obj.resetTokenExpiry;
    delete obj.__v;
    return obj;
};

module.exports = mongoose.model('User', userSchema);
