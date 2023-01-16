import {
  CACHE_MANAGER,
  ConflictException,
  Inject,
  NotFoundException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { UsersService } from '../users/users.service';
import { AuthsService } from './auths.service';
import { IContext } from 'src/commons/type/context';
import * as bcrypt from 'bcrypt';
import {
  GqlAuthAccessGuard,
  GqlAuthRefreshGuard,
} from 'src/commons/auth/gql-auth.guard';
import { Cache } from 'cache-manager';

@Resolver()
export class AuthsResolver {
  constructor(
    private readonly usersService: UsersService, //
    private readonly authsService: AuthsService, //
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache, //
  ) {}

  @Mutation(() => String)
  async login(
    @Args('email', { description: '로그인 할 회원 이메일 정보' }) email: string, //
    @Args('password', { description: '로그인 할 회원 비밀번호' })
    password: string,
    @Context() Context: IContext,
  ) {
    const user = await this.usersService.findOne({ email });
    if (!user) throw new UnprocessableEntityException('이메일이 없습니다.');

    const isAuth = await bcrypt.compare(password, user.password);
    if (!isAuth) throw new UnprocessableEntityException('암호가 틀렸습니다.');

    this.authsService.setRefreshToken({
      user,
      res: Context.res,
      req: Context.req,
    });

    return this.authsService.getAccessToken({ user });
  }

  /**
   * Restore Access Token API
   * @type [`Mutation`]
   * @param context 현재 접속한 유저의 정보
   * @returns 재발급된 AccessToken
   */
  @UseGuards(GqlAuthRefreshGuard)
  @Mutation(() => String, { description: 'Return : 재발급된 AccessToken' })
  restoreAccessToken(
    @Context() context: IContext, //
  ) {
    return this.authsService.getAccessToken({ user: context.req.user });
  }

  /**
   * User Logout API
   * @type [`Mutation`]
   * @param context 현재 접속한 유저의 정보
   * @returns 로그아웃 성공여부
   */
  @UseGuards(GqlAuthAccessGuard)
  @Mutation(() => Boolean, {
    description: 'Return : 로그아웃 성공여부 (true / false)',
  })
  async userLogout(
    @Context() context: IContext, //
  ) {
    const accessToken = context.req.headers.authorization.replace(
      'Bearer ',
      '',
    );
    const refreshToken = context.req.headers.cookie.replace(
      'refreshToken=',
      '',
    );

    const { validAccessToken, validRefreshToken } =
      this.authsService.verifyTokens({
        accessToken,
        refreshToken,
      });

    const now = new Date().getTime();
    const accessTokenTtl =
      validAccessToken.exp - Number(String(now).slice(0, -3));
    const refreshTokenTtl =
      validRefreshToken.exp - Number(String(now).slice(0, -3));

    let result = true;
    try {
      // Redis에 토큰 저장 (redis - blacklist 생성)
      await this.cacheManager.set(
        `accessToken:${accessToken}`,
        'accessToken', //
        { ttl: accessTokenTtl },
      );
      await this.cacheManager.set(
        `refreshToken:${refreshToken}`,
        'refreshToken',
        { ttl: refreshTokenTtl },
      );
    } catch (e) {
      result = false;
      console.log(e);
    }

    return result;
  }
  /**
   * Create Mail Token API
   * @type [`Mutation`]
   * @param email 토큰발급 후 검증을 위해 전송될 메일주소
   * @returns 메일발송 성공 여부 (true / false)
   */
  @Mutation(() => Boolean, {
    description: 'Return : 메일발송 성공 여부 (true / false)',
  })
  async createMailToken(
    @Args('email', { description: '토큰발급 후 검증을 위해 전송될 메일주소' })
    email: string, //
    @Args('type', {
      description: '사용목적 : 회원가입(signUp), 비밀번호 변경(resetPwd)',
    })
    type: string, //
  ) {
    const user = await this.usersService.findOne({ email });
    if (type === 'signUp') {
      if (user) throw new ConflictException('이미 등록된 계정입니다.');
    }
    if (type === 'resetPwd') {
      if (!user)
        throw new NotFoundException('해당 이메일의 가입 내역이 없습니다.');
    }
    const sendTokenToMail = await this.authsService.sendMailToken({ email });
    return sendTokenToMail;
  }

  /**
   * Verify Mail Token API
   * @type [`Mutation`]
   * @param email 토큰이 전송된 메일주소
   * @param code 입력받은 토큰정보
   * @returns 인증토큰 일치 여부 (true / false)
   */
  @Mutation(() => Boolean, {
    description: 'Return : 인증토큰 일치 여부 (true / false)',
  })
  async verifyMailToken(
    @Args('email', { description: '토큰이 전송된 메일주소' }) email: string, //
    @Args('code', { description: '입력받은 토큰정보' }) code: string,
  ) {
    const isValid = await this.authsService.validateMailToken({ email, code });
    return isValid;
  }
}
