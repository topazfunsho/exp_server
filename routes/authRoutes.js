const express = require('express');
const router = express.Router();
const { register, login, getMe, getAllUsers } = require('../controllers/userController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

// POST /api/auth/register
router.post('/register', register);

// POST /api/auth/login
router.post('/login', login);

// GET /api/auth/me  — requires valid token
router.get('/me', protect, getMe);

// GET /api/auth/users  — admin only
router.get('/users', protect, adminOnly, getAllUsers);

module.exports = router;
