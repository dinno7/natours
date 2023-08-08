const jwt = require('jsonwebtoken');
const { promisify } = require('util');

const User = require('../user/user.model');
const { AppError, catchError } = require('../../../utils');
const { sendEmail } = require('./email.controller');
const { createSendJWTToken, filterObj } = require('../../../utils/global');

// >> Controllers:
module.exports = {
  singUp: catchError(async function(req, res, next) {
    const { name, email, password, passwordConfirm } = req.body;
    const newUser = await User.create({
      name,
      email,
      password,
      passwordConfirm
    });

    newUser.password = undefined;
    createSendJWTToken(res, newUser, 201);
  }),

  login: catchError(async function(req, res, next) {
    const { email, password } = req.body;

    // Check email and password that came from front-end
    if (!email || !password) {
      return next(new AppError('Please provide email and password', 400));
    }

    // Check is user exist and password is correct
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.isPasswordCorrect(password, user.password)))
      return next(new AppError('Incorrect email or password', 401));

    // Remove password from response and generate token then send them as a response
    user.password = undefined;
    createSendJWTToken(res, user, 201);
  }),

  protect: catchError(async function(req, res, next) {
    // 1) Getting token and check of it's there
    const { authorization } = req.headers;
    let token = null;
    if (authorization && authorization.startsWith('Bearer')) {
      token = authorization.split(' ').at(-1);
    }
    if (!token)
      return next(
        new AppError('You are not logged in, please login to get access'),
        401
      );

    // 2) Verification token
    const decoded = await promisify(jwt.verify)(
      token,
      process.env.JWT_SECRET_64
    );

    // 3) Check if user still exist
    const currentUser = await User.findById(decoded.id).select([
      '-__v',
      '+password'
    ]);
    if (!currentUser)
      return next(
        new AppError(
          'The user related by this token is not exist, please signup or login',
          401
        )
      );

    // 4) Check if user changed password after the token was issued
    if (currentUser.changedPasswordAfter(decoded.iat))
      return next(
        new AppError('User changed password recently, please login again', 401)
      );
    req.user = currentUser;
    next();
  }),

  restrictTo: (...roles) => (req, res, next) => {
    const user = req.user;
    if (!user || !roles.includes(user.role))
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    next();
  },

  forgotPassword: catchError(async function(req, res, next) {
    // 1) Get user based on POSTed email
    const { email } = req.body;
    if (!email) return next(new AppError('Please provide email address', 400));
    const user = await User.findOne({ email });
    if (!user)
      return next(new AppError('There is no user with this email', 404));
    // 2) Generate random reset token
    const resetToken = user.generatePasswordResetToken();
    user.save({ validateBeforeSave: false });
    // 3) Send it to user's email
    const resetUrl = `${req.protocol}://${req.get(
      'host'
    )}/api/v1/users/resetPassword/${resetToken}`;
    const message = `Forgot your password?
    Submit a PATCH request with your new password and confirm password to: ${resetUrl}
    If you did not forgot your password, please ignore this email!`;

    try {
      await sendEmail({
        email: user.email,
        subject: 'Reset your password (Validate for 10 mins)',
        message
      });

      res.send({
        ok: true,
        status: 'success',
        message:
          'We sent email contain reset password url, check your email inbox'
      });
    } catch (error) {
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      user.save({ validateBeforeSave: false });

      return next(
        new AppError(
          'There was an error sending the email, please try again later!',
          500
        )
      );
    }
  }),

  resetPassword: catchError(async function(req, res, next) {
    const { newPassword, newPasswordConfirm } = req.body;
    const { token } = req.params;
    // 1) Check password, passwordConfirm, token existence
    if (!newPassword || !newPasswordConfirm || !token)
      return next(
        new AppError(
          'Please provide new password and confirm password and reset password token',
          400
        )
      );

    // 2) Find user by token and token expires date
    const user = await User.getUserByResetPasswordToken(token);
    if (!user)
      return next(
        new AppError("Invalid token or token's expires time has reached!", 403)
      );

    // 3) Check if user choose new password similar current password
    if (await user.isPasswordCorrect(newPassword, user.password))
      return next(
        new AppError(
          'You can not choose new password similar your current password, Login again with this password or choose another new password',
          400
        )
      );
    // 3) Set new password for user
    user.password = newPassword;
    user.passwordConfirm = newPasswordConfirm;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    // 4) Create and send JWT token
    createSendJWTToken(res, user, 200);
  }),

  updatePassword: catchError(async function(req, res, next) {
    if (!req?.user?._id) return next(new AppError('Please login first', 401));

    const { currentPassword, newPassword, newPasswordConfirm } = req.body;
    if (!currentPassword || !newPassword || !newPasswordConfirm)
      return next(
        new AppError(
          'Please provide your current password and new password and confirm of new password',
          400
        )
      );

    if (currentPassword === newPassword)
      return next(
        new AppError(
          'Your new password is your current password, please choose another one',
          400
        )
      );

    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.isPasswordCorrect(currentPassword, req.user.password)))
      return next(new AppError('Your current password is wrong', 401));

    user.password = newPassword;
    user.passwordConfirm = newPasswordConfirm;
    await user.save();

    createSendJWTToken(res, user, 200);
  }),

  updateUser: catchError(async function(req, res, next) {
    const body = req.body;
    // 1) Create error if user POSTs password data
    if (body.password || body.passwordConfirm)
      return next(
        new AppError(
          'This route is not for password update. Please use /updateMyPassword',
          400
        )
      );

    // 2) Filter out unwanted fields
    const filteredFields = filterObj(body, 'name', 'email');

    // 3) Update user document
    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      filteredFields,
      { new: true, runValidators: true }
    );

    res.send({
      ok: true,
      status: 'success',
      data: {
        updatedUser
      }
    });
  })
};
