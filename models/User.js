const mongoose = require('mongoose');

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
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Encode password as Base64 before saving
userSchema.pre('save', function (next) {
    if (!this.isModified('passwordHash')) return next();
    this.passwordHash = Buffer.from(this.passwordHash).toString('base64');
    next();
});

// Compare password (decode Base64 and compare)
userSchema.methods.comparePassword = function (password) {
    const decoded = Buffer.from(this.passwordHash, 'base64').toString('utf-8');
    return decoded === password;
};

// Recover password (decode Base64)
userSchema.methods.getPassword = function () {
    return Buffer.from(this.passwordHash, 'base64').toString('utf-8');
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.passwordHash;
    delete obj.__v;
    return obj;
};

module.exports = mongoose.model('User', userSchema);
