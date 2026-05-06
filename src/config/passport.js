const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const env = require('./env');
const { persistGoogleUser } = require('../services/authUserService');

passport.use(
  new GoogleStrategy(
    {
      clientID: env.googleClientId,
      clientSecret: env.googleClientSecret,
      callbackURL: env.googleCallbackUrl,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const user = await persistGoogleUser(profile);
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

module.exports = passport;
