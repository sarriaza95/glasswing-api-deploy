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
      passReqToCallback: true,
    },
    async (req, _accessToken, _refreshToken, profile, done) => {
      try {
        const user = await persistGoogleUser(profile, req.session?.registrationCountry);
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
